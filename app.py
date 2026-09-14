from __future__ import annotations

import copy
import json
import math
import os
import secrets
import tempfile
import threading
import time
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_FILE = BASE_DIR / "data.json"

app = Flask(
    __name__,
    static_folder=str(PUBLIC_DIR),
    static_url_path="/static",
)

# Local-only default: a new key is generated at startup unless you provide one.
# For a persistent session secret, set FLASK_SECRET_KEY in the environment.
app.config.update(
    SECRET_KEY=os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32),
    MAX_CONTENT_LENGTH=1 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,  # localhost / 127.0.0.1 is HTTP in this setup
)

DEFAULT_DB = {
    "entries": [],
    "settings": {
        "name": "",
        "founder": "",
        "defaultRate": 85,
        "startDate": "2026-03-01",
    },
}

ALLOWED_CATEGORIES = {
    "Engineering / Development", "Design", "Research & Experimentation",
    "Product / Strategy", "Marketing / Growth", "Ops / Admin / Legal",
    "Fundraising / Investor Relations", "Customer / Sales",
}
ALLOWED_CLASSIFICATIONS = {"sweat", "bill", "internal"}
ALLOWED_RD = {"no", "yes", "maybe"}
ALLOWED_STATUS = {"Unpaid", "Invoiced", "Paid (W-2)", "Paid (1099)", "Converted to equity"}
ALLOWED_RATE_BASIS = {
    "Market replacement rate", "Personal W-2 rate (sanity check)",
    "Contractor / 1099 rate", "Agreed equity-value rate",
}
ALLOWED_CONFIDENCE = {
    "High — from contemporaneous log",
    "Medium — from calendar/commits",
    "Low — reconstructed estimate",
}

# Passwords are stored as hashes in environment variables.
# Generate hashes with:
# python -c "from werkzeug.security import generate_password_hash; print(generate_password_hash('YOUR_PASSWORD'))"
USERS = {
    "user": {"role": "user", "password_hash": os.environ.get("USER_PASSWORD_HASH", "")},
    "admin": {"role": "admin", "password_hash": os.environ.get("ADMIN_PASSWORD_HASH", "")},
}

DATA_LOCK = threading.RLock()
LOGIN_ATTEMPTS = {}
LOGIN_WINDOW_SECONDS = 300
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_SECONDS = 60


def json_error(message, status=400):
    return jsonify({"error": message}), status


def load():
    with DATA_LOCK:
        if not DATA_FILE.exists():
            return copy.deepcopy(DEFAULT_DB)

        try:
            with DATA_FILE.open("r", encoding="utf-8") as f:
                db = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("Unable to read application data.") from exc

        if not isinstance(db, dict):
            raise RuntimeError("Application data must be a JSON object.")

        entries = db.get("entries", [])
        settings = db.get("settings", {})

        if not isinstance(entries, list) or not isinstance(settings, dict):
            raise RuntimeError("Application data structure is invalid.")

        result = copy.deepcopy(DEFAULT_DB)
        result["entries"] = entries
        result["settings"].update(settings)
        return result


def save(db):
    with DATA_LOCK:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_name = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=DATA_FILE.parent,
                prefix=".data-",
                suffix=".tmp",
                delete=False,
            ) as tmp:
                json.dump(db, tmp, indent=2, ensure_ascii=False)
                tmp.flush()
                os.fsync(tmp.fileno())
                temp_name = tmp.name

            os.replace(temp_name, DATA_FILE)
        except OSError as exc:
            if temp_name:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass
            raise RuntimeError("Unable to save application data.") from exc


def finite_number(value, field_name):
    try:
        value = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a number.") from exc

    if not math.isfinite(value):
        raise ValueError(f"{field_name} must be finite.")

    return value


def validate_date(value):
    if not isinstance(value, str):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def validate_time(value):
    if value in ("", None):
        return True
    if not isinstance(value, str):
        return False
    try:
        datetime.strptime(value, "%H:%M")
        return True
    except ValueError:
        return False


def clean_text(value, field_name, max_length):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be text.")
    value = value.strip()
    if len(value) > max_length:
        raise ValueError(f"{field_name} is too long.")
    return value


def validate_entry(entry, require_id=True):
    if not isinstance(entry, dict):
        return False, "Each entry must be an object.", None

    try:
        entry_id = clean_text(entry.get("id"), "ID", 100)
        if require_id and not entry_id:
            return False, "Entry ID is required.", None
        if not entry_id:
            entry_id = secrets.token_hex(16)

        date = entry.get("date")
        if not validate_date(date):
            return False, "Date must be YYYY-MM-DD.", None

        if not validate_time(entry.get("start")) or not validate_time(entry.get("end")):
            return False, "Start/end time must be HH:MM.", None

        hours = finite_number(entry.get("hours"), "Hours")
        rate = finite_number(entry.get("rate"), "Rate")

        if hours < 0:
            return False, "Hours cannot be negative.", None
        if hours > 24:
            return False, "Hours cannot exceed 24 for a single entry.", None
        if rate < 0 or rate > 500:
            return False, "Rate must be between $0 and $500 per hour.", None

        project = clean_text(entry.get("project"), "Project", 200)
        task = clean_text(entry.get("task"), "Task", 500)
        evidence = clean_text(entry.get("evidence"), "Evidence", 1000)
        notes = clean_text(entry.get("notes"), "Notes", 5000)

        category = clean_text(entry.get("category"), "Category", 100)
        classification = clean_text(entry.get("classification"), "Classification", 20)
        rate_basis = clean_text(entry.get("rateBasis"), "Rate basis", 100)
        rd = clean_text(entry.get("rd"), "R&D status", 10)
        status = clean_text(entry.get("status"), "Payment status", 50)
        confidence = clean_text(entry.get("confidence"), "Confidence", 100)

        if category not in ALLOWED_CATEGORIES:
            return False, "Invalid activity category.", None
        if classification not in ALLOWED_CLASSIFICATIONS:
            return False, "Invalid classification.", None
        if rate_basis not in ALLOWED_RATE_BASIS:
            return False, "Invalid rate basis.", None
        if rd not in ALLOWED_RD:
            return False, "Invalid R&D status.", None
        if status not in ALLOWED_STATUS:
            return False, "Invalid payment status.", None
        if confidence not in ALLOWED_CONFIDENCE:
            return False, "Invalid confidence value.", None

        clean = {
            "id": entry_id,
            "date": date,
            "start": entry.get("start") or "",
            "end": entry.get("end") or "",
            "hours": round(hours, 4),
            "project": project,
            "task": task,
            "category": category,
            "classification": classification,
            "rate": round(rate, 2),
            "rateBasis": rate_basis,
            "rd": rd,
            "status": status,
            "confidence": confidence,
            "evidence": evidence,
            "notes": notes,
        }
        return True, "", clean

    except ValueError as exc:
        return False, str(exc), None


def validate_settings(data):
    if not isinstance(data, dict):
        return False, "Settings must be a JSON object.", None

    try:
        name = clean_text(data.get("name"), "Startup name", 200)
        founder = clean_text(data.get("founder"), "Founder", 200)
        start_date = data.get("startDate")
        if not validate_date(start_date):
            return False, "Tracking start date must be YYYY-MM-DD.", None

        rate = finite_number(data.get("defaultRate"), "Default rate")
        if rate < 0 or rate > 500:
            return False, "Default rate must be between $0 and $500/hr.", None

        return True, "", {
            "name": name,
            "founder": founder,
            "defaultRate": round(rate, 2),
            "startDate": start_date,
        }
    except ValueError as exc:
        return False, str(exc), None


def client_key():
    return request.remote_addr or "unknown"


def login_allowed():
    now = time.monotonic()
    record = LOGIN_ATTEMPTS.get(client_key())
    if not record:
        return True
    if now - record["first"] > LOGIN_WINDOW_SECONDS:
        LOGIN_ATTEMPTS.pop(client_key(), None)
        return True
    return record["locked_until"] <= now and record["failures"] < MAX_FAILED_ATTEMPTS


def record_login_failure():
    now = time.monotonic()
    record = LOGIN_ATTEMPTS.get(client_key())
    if not record or now - record["first"] > LOGIN_WINDOW_SECONDS:
        LOGIN_ATTEMPTS[client_key()] = {"first": now, "failures": 1, "locked_until": 0}
        return

    record["failures"] += 1
    if record["failures"] >= MAX_FAILED_ATTEMPTS:
        record["locked_until"] = now + LOCKOUT_SECONDS


def clear_login_failures():
    LOGIN_ATTEMPTS.pop(client_key(), None)


def authenticate(role, password):
    user = USERS.get(role)
    if not user or not user["password_hash"]:
        return False
    return check_password_hash(user["password_hash"], password)


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("role"):
            return json_error("Authentication required.", 401)
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if session.get("role") != "admin":
            return json_error("Admin role required.", 403)
        return view(*args, **kwargs)
    return wrapped


def csrf_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        expected = session.get("csrf_token")
        supplied = request.headers.get("X-CSRF-Token")
        if not expected or not supplied or not secrets.compare_digest(expected, supplied):
            return json_error("Invalid CSRF token.", 403)
        return view(*args, **kwargs)
    return wrapped


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'"
    )
    return response


@app.errorhandler(413)
def request_too_large(_):
    return json_error("Request body is too large.", 413)


@app.route("/")
def index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.route("/api/login", methods=["POST"])
def login():
    if not login_allowed():
        return json_error("Too many failed attempts. Try again in about 60 seconds.", 429)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        record_login_failure()
        return json_error("Invalid JSON body.", 400)

    role = data.get("role")
    password = data.get("password")

    if not isinstance(role, str) or not isinstance(password, str):
        record_login_failure()
        return json_error("Role and password are required.", 400)

    if not authenticate(role, password):
        record_login_failure()
        return json_error("Invalid credentials.", 401)

    clear_login_failures()
    session.clear()
    session["role"] = role
    session["csrf_token"] = secrets.token_urlsafe(32)

    return jsonify({"ok": True, "role": role, "csrfToken": session["csrf_token"]})


@app.route("/api/me", methods=["GET"])
@login_required
def me():
    return jsonify({
        "ok": True,
        "role": session["role"],
        "csrfToken": session["csrf_token"],
    })


@app.route("/api/logout", methods=["POST"])
@login_required
@csrf_required
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/state", methods=["GET"])
@login_required
def get_state():
    try:
        return jsonify(load())
    except RuntimeError as exc:
        return json_error(str(exc), 500)


@app.route("/api/entries", methods=["GET"])
@login_required
def get_entries():
    try:
        return jsonify(load()["entries"])
    except RuntimeError as exc:
        return json_error(str(exc), 500)


@app.route("/api/entries", methods=["POST"])
@login_required
@csrf_required
def replace_entries():
    data = request.get_json(silent=True)
    if not isinstance(data, list):
        return json_error("Request body must be a JSON array.", 400)

    clean_entries = []
    seen_ids = set()
    for entry in data:
        valid, message, clean = validate_entry(entry, require_id=True)
        if not valid:
            return json_error(message, 400)
        if clean["id"] in seen_ids:
            return json_error("Duplicate entry ID.", 400)
        seen_ids.add(clean["id"])
        clean_entries.append(clean)

    try:
        db = load()
        db["entries"] = clean_entries
        save(db)
        return jsonify({"ok": True})
    except RuntimeError as exc:
        return json_error(str(exc), 500)


@app.route("/api/entries", methods=["DELETE"])
@login_required
@admin_required
@csrf_required
def delete_entries():
    try:
        db = load()
        db["entries"] = []
        save(db)
        return jsonify({"ok": True})
    except RuntimeError as exc:
        return json_error(str(exc), 500)


@app.route("/api/settings", methods=["POST"])
@login_required
@csrf_required
def set_settings():
    data = request.get_json(silent=True)
    valid, message, clean = validate_settings(data)
    if not valid:
        return json_error(message, 400)

    try:
        db = load()
        db["settings"] = clean
        save(db)
        return jsonify({"ok": True})
    except RuntimeError as exc:
        return json_error(str(exc), 500)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=False)
