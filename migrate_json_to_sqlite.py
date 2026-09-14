from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from app import DB_FILE, init_db, normalize_entry, validate_settings

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_SOURCE = BASE_DIR / "data.json"


def main():
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE

    if not source.exists():
        print(f"Source file not found: {source}")
        raise SystemExit(1)

    with source.open("r", encoding="utf-8") as f:
        source_db = json.load(f)

    if not isinstance(source_db, dict):
        raise SystemExit("data.json must contain a JSON object.")

    entries = source_db.get("entries", [])
    settings = source_db.get("settings", {})

    if not isinstance(entries, list):
        raise SystemExit("data.json 'entries' must be a list.")

    try:
        clean_settings = validate_settings({
            "name": settings.get("name", ""),
            "founder": settings.get("founder", ""),
            "defaultRate": settings.get("defaultRate", 85),
            "startDate": settings.get("startDate", "2026-03-01"),
        })
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"Invalid settings: {exc}")

    init_db()

    with sqlite3.connect(DB_FILE) as db:
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("""
            UPDATE settings
            SET name=?, founder=?, default_rate=?, start_date=?
            WHERE id=1
        """, (
            clean_settings["name"],
            clean_settings["founder"],
            clean_settings["defaultRate"],
            clean_settings["startDate"],
        ))

        imported = 0
        skipped = 0
        now = datetime.utcnow().isoformat(timespec="seconds") + "Z"

        for raw in entries:
            try:
                entry = normalize_entry(raw)
                db.execute("""
                    INSERT INTO entries (
                        id, date, start_time, end_time, hours, project, task, category,
                        classification, rate, rate_basis, rd, status, confidence,
                        evidence, notes, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    entry["id"], entry["date"], entry["start"], entry["end"], entry["hours"],
                    entry["project"], entry["task"], entry["category"], entry["classification"],
                    entry["rate"], entry["rateBasis"], entry["rd"], entry["status"],
                    entry["confidence"], entry["evidence"], entry["notes"], now, now
                ))
                imported += 1
            except (TypeError, ValueError, sqlite3.IntegrityError) as exc:
                skipped += 1
                print(f"Skipped entry {raw.get('id', '<no-id>')}: {exc}")

        db.commit()

    print(f"Migration complete.")
    print(f"Source:    {source}")
    print(f"Database:  {DB_FILE}")
    print(f"Imported:  {imported}")
    print(f"Skipped:   {skipped}")
    print("The original data.json was not modified or deleted.")


if __name__ == "__main__":
    main()
