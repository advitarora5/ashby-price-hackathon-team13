"""SQLite access. One connection per call site; WAL so the API can read while
offline scripts write."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA = Path(__file__).with_name("schema.sql")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def connect(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


# Columns added after the first release of a table. CREATE TABLE IF NOT EXISTS does
# not add columns to an existing table, so they are added here (idempotent).
MIGRATIONS = {
    "cases": [("uncertainty_score", "REAL"), ("routing_signal", "TEXT"), ("tissue_artifact_share", "REAL"),
              ("tier_reasons", "TEXT")],
    "reads": [("last_light", "TEXT"), ("signout_attempts", "INTEGER NOT NULL DEFAULT 0"),
              ("second_decision", "TEXT"), ("third_decision", "TEXT"), ("notes", "TEXT"), ("notes_saved_at", "TEXT")],
}


def migrate(con: sqlite3.Connection) -> None:
    for table, cols in MIGRATIONS.items():
        have = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        for name, decl in cols:
            if name not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
    con.commit()


def init_db(path: Path | str) -> sqlite3.Connection:
    con = connect(path)
    con.executescript(SCHEMA.read_text())
    migrate(con)
    con.commit()
    return con


@contextmanager
def tx(con: sqlite3.Connection):
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise


def upsert(con: sqlite3.Connection, table: str, row: dict[str, Any]) -> None:
    cols = list(row)
    q = (f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
         f"ON CONFLICT DO UPDATE SET {','.join(f'{c}=excluded.{c}' for c in cols)}")
    con.execute(q, [_val(row[c]) for c in cols])


def insert_many(con: sqlite3.Connection, table: str, rows: Iterable[dict[str, Any]], replace: bool = True) -> int:
    rows = list(rows)
    if not rows:
        return 0
    cols = list(rows[0])
    verb = "INSERT OR REPLACE" if replace else "INSERT"
    con.executemany(f"{verb} INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                    [[_val(r[c]) for c in cols] for r in rows])
    return len(rows)


def _val(v):
    if isinstance(v, (dict, list)):
        return json.dumps(v)
    if hasattr(v, "item"):  # numpy scalar
        return v.item()
    return v


def one(con: sqlite3.Connection, q: str, *args) -> dict | None:
    r = con.execute(q, args).fetchone()
    return dict(r) if r else None


def all_(con: sqlite3.Connection, q: str, *args) -> list[dict]:
    return [dict(r) for r in con.execute(q, args).fetchall()]
