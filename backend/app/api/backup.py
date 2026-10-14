import asyncio
import json
import sqlite3
import os
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.config import settings

from app.api.auth import get_current_admin

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/backup", tags=["backup"])

MAX_BACKUP_BYTES = 10 * 1024 * 1024

# Backup key -> table a backup may restore. agent_tokens is left out, matching the
# export (Issue 13): restoring old agent credentials would revive revoked agents.
ALLOWED_TABLE_MAP = {
    "device_groups": "device_groups",
    "devices": "devices",
    "services": "services",
    "discovered_hosts": "discovered_hosts",
    "settings": "app_settings",
    "agent_configs": "agent_configs",
    "subnets": "subnets",
    "topology_links": "topology_links",
    "racks": "racks",
}

# Credentials and setup state of the running instance. An import never deletes or
# replaces them: a backup from another instance (or a tampered one) would otherwise
# lock the admin out, hand over access, or reopen the unauthenticated setup wizard.
PROTECTED_SETTING_KEYS = ("api.master_token", "api.admin_password", "setup.complete")


@router.get("/export", dependencies=[Depends(get_current_admin)])
async def export_backup():
    """Export the current database state as a JSON file."""
    db_path = settings.effective_database_url.replace("sqlite+aiosqlite:///", "")
    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail="Database file not found")

    def _read_db() -> dict:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        data: dict = {
            "metadata": {
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "version": "0.1.0",
                "source": "GravityLAN Dashboard",
            },
            "device_groups": [],
            "devices": [],
            "services": [],
            "discovered_hosts": [],
            "settings": [],
        }
        tables = {
            "device_groups": "device_groups",
            "devices": "devices",
            "services": "services",
            "discovered_hosts": "discovered_hosts",
            "settings": "app_settings",
            # "agent_tokens": "agent_tokens", # EXCLUDED for security (Issue 13)
            "agent_configs": "agent_configs",
            "subnets": "subnets",
            "topology_links": "topology_links",
            "racks": "racks",
        }
        for key, table in tables.items():
            try:
                cursor.execute(f"SELECT * FROM {table}")
                data[key] = [dict(row) for row in cursor.fetchall()]
            except sqlite3.OperationalError as e:
                logger.warning(f"Backup: Table {table} skipped ({e})")
        conn.close()
        return data

    try:
        data = await asyncio.to_thread(_read_db)
        filename = f"gravitylan_backup_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.json"
        return JSONResponse(
            content=data,
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    except Exception as e:
        logger.error(f"Backup: Export failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _read_protected_settings(cursor) -> dict[str, str]:
    """Current values of the protected app_settings keys."""
    placeholders = ", ".join("?" * len(PROTECTED_SETTING_KEYS))
    cursor.execute(f"SELECT key, value FROM app_settings WHERE key IN ({placeholders})", PROTECTED_SETTING_KEYS)
    return dict(cursor.fetchall())


def _clean_rows(cursor, table: str, rows: list[dict]) -> list[dict]:
    """Keep only known columns and fill NOT NULL columns the backup left empty."""
    cursor.execute(f"PRAGMA table_info({table})")
    table_info = {
        col[1]: {"notnull": col[3], "default": col[4], "type": col[2]}
        for col in cursor.fetchall()
    }
    if not table_info:
        logger.error(f"Backup: Table {table} not found in DB")
        return []

    if table == "app_settings":
        # Protected keys stay as they are; ids are reassigned so restored rows
        # cannot collide with the protected rows that remain in the table.
        rows = [r for r in rows if r.get("key") not in PROTECTED_SETTING_KEYS]
        table_info.pop("id", None)

    now_str = datetime.now(timezone.utc).isoformat().replace("T", " ")
    valid_rows = []
    for row in rows:
        clean_row = {
            col: val
            for col, val in row.items()
            if col in table_info and not (val is None and table_info[col]["notnull"])
        }
        for col, info in table_info.items():
            if info["notnull"] and (col not in clean_row or clean_row[col] is None):
                if any(t in info["type"].upper() for t in ("DATETIME", "TIMESTAMP")):
                    clean_row[col] = now_str
                elif any(t in info["type"].upper() for t in ("INT", "BOOLEAN")):
                    clean_row[col] = 0
                else:
                    clean_row[col] = ""
        valid_rows.append(clean_row)
    return valid_rows


def _write_db(db_path: str, data: dict) -> dict[str, int]:
    """Replace the allowed tables with the backup rows in a single transaction.

    Any error rolls everything back, so a failed import never leaves a
    half-deleted database behind.
    """
    # isolation_level=None: no implicit transactions, BEGIN/COMMIT are explicit below
    conn = sqlite3.connect(db_path, isolation_level=None)
    cursor = conn.cursor()
    try:
        # Only takes effect outside a transaction, so it is set before BEGIN
        cursor.execute("PRAGMA foreign_keys = OFF")
        cursor.execute("BEGIN IMMEDIATE")
        protected_before = _read_protected_settings(cursor)
        imported: dict[str, int] = {}

        for key, rows in data.items():
            if key == "metadata" or not rows:
                continue
            if key not in ALLOWED_TABLE_MAP:
                logger.warning(f"Backup: Skipping unauthorized table key '{key}'")
                continue

            table = ALLOWED_TABLE_MAP[key]
            valid_rows = _clean_rows(cursor, table, rows)
            if not valid_rows:
                continue

            if table == "app_settings":
                placeholders = ", ".join("?" * len(PROTECTED_SETTING_KEYS))
                cursor.execute(f"DELETE FROM app_settings WHERE key NOT IN ({placeholders})", PROTECTED_SETTING_KEYS)
            else:
                cursor.execute(f"DELETE FROM {table}")
            columns = list(valid_rows[0].keys())
            placeholders = ", ".join(["?"] * len(columns))
            col_names = ", ".join(columns)
            cursor.executemany(
                f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
                [tuple(r.get(c) for c in columns) for r in valid_rows],
            )
            imported[table] = len(valid_rows)

        if _read_protected_settings(cursor) != protected_before:
            raise RuntimeError("Backup import would change protected settings")

        conn.commit()
        return imported
    except Exception:
        conn.rollback()
        raise
    finally:
        try:
            cursor.execute("PRAGMA foreign_keys = ON")
        finally:
            conn.close()


def _validate_backup_shape(data) -> None:
    """Reject payloads that are not {table_key: [row, ...]} before touching the database."""
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Invalid backup file: expected a JSON object")
    for key, rows in data.items():
        if key == "metadata" or key not in ALLOWED_TABLE_MAP or not rows:
            continue
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise HTTPException(status_code=400, detail=f"Invalid backup file: '{key}' must be a list of rows")


@router.post("/import", dependencies=[Depends(get_current_admin)])
async def import_backup(file: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    """Import a JSON backup file into the database."""
    if not file.filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="Only JSON files are supported")

    # Issue 8: Read with size limit (10MB max) to prevent memory exhaustion DOS
    content = await file.read(size=MAX_BACKUP_BYTES)
    if len(content) >= MAX_BACKUP_BYTES:
        raise HTTPException(status_code=413, detail="Backup file too large (max 10MB)")

    try:
        data = json.loads(content)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid backup file: not valid JSON")
    _validate_backup_shape(data)

    db_path = settings.effective_database_url.replace("sqlite+aiosqlite:///", "")
    try:
        imported = await asyncio.to_thread(_write_db, db_path, data)
    except Exception as e:
        logger.error(f"Backup: Import failed, all changes rolled back: {e}")
        raise HTTPException(status_code=500, detail=f"Backup import failed, no changes were made: {e}")

    for table, count in imported.items():
        logger.info(f"Backup: Imported {count} rows into {table}")

    return {"status": "ok", "message": "Backup successfully imported"}
