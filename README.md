# V2 — SQLite Edition

This version keeps the same localhost UI but moves persistence from a single JSON document to SQLite.

## Run

Copy your existing `data.json` into this folder, then:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

$env:FLASK_SECRET_KEY="paste-a-long-random-secret-here"
$env:USER_PASSWORD_HASH="paste-user-hash-here"
$env:ADMIN_PASSWORD_HASH="paste-admin-hash-here"

python migrate_json_to_sqlite.py
python app.py
```

Open:

```text
http://127.0.0.1:8000
```

The migration script leaves the source `data.json` untouched.

## V2 changes

- SQLite instead of `data.json`
- Individual entry create/update/delete APIs
- Transactional writes
- WAL mode for better local concurrency
- Indexes for dates/projects/classification/R&D
- Audit timestamps (`created_at`, `updated_at`)
- Server-generated timestamps
- Same server-side auth/CSRF/security-header model as V1
- Same dashboard and CSV workflow
- Admin-only bulk insertion uses a dedicated transaction
