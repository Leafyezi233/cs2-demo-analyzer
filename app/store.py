"""SQLite 存储：一场 demo 一条 matches 记录，数据集以 JSON 分表存放。"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS matches (
    id            TEXT PRIMARY KEY,
    file_name     TEXT NOT NULL,
    file_path     TEXT,
    file_size     INTEGER,
    map_name      TEXT,
    server_name   TEXT,
    tick_rate     REAL,
    playback_time REAL,
    parse_seconds REAL,
    ct_score      INTEGER DEFAULT 0,
    t_score       INTEGER DEFAULT 0,
    round_count   INTEGER DEFAULT 0,
    created_at    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS datasets (
    match_id TEXT NOT NULL,
    name     TEXT NOT NULL,
    payload  TEXT NOT NULL,
    PRIMARY KEY (match_id, name)
);
CREATE TABLE IF NOT EXISTS extra (
    match_id TEXT NOT NULL,
    name     TEXT NOT NULL,
    payload  TEXT NOT NULL,
    PRIMARY KEY (match_id, name)
);
CREATE INDEX IF NOT EXISTS idx_datasets_match ON datasets(match_id);
"""


class Store:
    def __init__(self, db_path: str):
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self.db_path = db_path
        self._init()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init(self) -> None:
        with self._conn() as conn:
            conn.executescript(SCHEMA)

    # ---------- 写入 ----------

    def save_match(self, parsed: dict, file_name: str, file_path: str | None, extra: dict[str, Any] | None = None) -> str:
        match_id = uuid.uuid4().hex[:16]
        meta = parsed["meta"]
        datasets = parsed["datasets"]
        rounds = datasets.get("rounds", [])
        ct = sum(1 for r in rounds if r.get("winner_side") == "counter-terrorist")
        t = sum(1 for r in rounds if r.get("winner_side") == "terrorist")
        size = None
        if file_path and os.path.exists(file_path):
            size = os.path.getsize(file_path)

        with self._conn() as conn:
            conn.execute(
                "INSERT INTO matches (id, file_name, file_path, file_size, map_name, server_name, tick_rate,"
                " playback_time, parse_seconds, ct_score, t_score, round_count, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    match_id, file_name, file_path, size, meta.get("map_name"), meta.get("server_name"),
                    meta.get("tick_rate"), meta.get("playback_time"), parsed.get("parse_seconds"),
                    ct, t, len(rounds), time.time(),
                ),
            )
            conn.executemany(
                "INSERT OR REPLACE INTO datasets (match_id, name, payload) VALUES (?,?,?)",
                [(match_id, name, json.dumps(rows, ensure_ascii=False)) for name, rows in datasets.items()],
            )
            if extra:
                conn.executemany(
                    "INSERT OR REPLACE INTO extra (match_id, name, payload) VALUES (?,?,?)",
                    [(match_id, name, json.dumps(value, ensure_ascii=False)) for name, value in extra.items()],
                )
        return match_id

    # ---------- 读取 ----------

    def list_matches(self) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT id, file_name, map_name, server_name, ct_score, t_score, round_count,"
                " playback_time, parse_seconds, file_size, created_at FROM matches ORDER BY created_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_match(self, match_id: str) -> dict | None:
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        return dict(row) if row else None

    def get_dataset(self, match_id: str, name: str) -> list[dict]:
        with self._conn() as conn:
            row = conn.execute("SELECT payload FROM datasets WHERE match_id = ? AND name = ?", (match_id, name)).fetchone()
        return json.loads(row["payload"]) if row else []

    def dataset_names(self, match_id: str) -> list[str]:
        with self._conn() as conn:
            rows = conn.execute("SELECT name FROM datasets WHERE match_id = ?", (match_id,)).fetchall()
        return [r["name"] for r in rows]

    def get_extra(self, match_id: str, name: str) -> Any:
        with self._conn() as conn:
            row = conn.execute("SELECT payload FROM extra WHERE match_id = ? AND name = ?", (match_id, name)).fetchone()
        return json.loads(row["payload"]) if row else None

    def delete_match(self, match_id: str) -> None:
        with self._conn() as conn:
            conn.execute("DELETE FROM matches WHERE id = ?", (match_id,))
            conn.execute("DELETE FROM datasets WHERE match_id = ?", (match_id,))
            conn.execute("DELETE FROM extra WHERE match_id = ?", (match_id,))
