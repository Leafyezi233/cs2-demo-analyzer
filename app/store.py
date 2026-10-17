"""SQLite 存储：带版本迁移的数据档案。

两层数据：
- 原始层 datasets：解析器吐出的每个数据集整体存档（zlib 压缩的 JSON）。这是「终态资产」——
  demo 本体删掉后仍可从这里重新派生任何统计，解析器升级也不影响历史数据的可读性。
- 派生层 rounds / player_match / player_round / kills / player_weapon / highlights：
  规范化的事实表，跨场、跨地图、分阵营的聚合都直接用 SQL 回答，不再在 Python / JS 里解 JSON。
  派生口径升级时（derive.DERIVE_VERSION），后台用原始层重算，不需要 demo。

迁移：schema_meta 记录版本；没有 schema_meta 但有 matches 表的库视为旧版（v1），
升级前自动把整个库备份到 数据/backups/。
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
import zlib
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA_VERSION = 2

ROUND_COLS = [
    ("round_num", "INTEGER"), ("start_tick", "INTEGER"), ("freeze_end_tick", "INTEGER"), ("end_tick", "INTEGER"),
    ("official_end_tick", "INTEGER"), ("winner_side", "TEXT"), ("reason_name", "TEXT"), ("team_a_side", "TEXT"),
    ("score_a", "INTEGER"), ("score_b", "INTEGER"), ("ct_equipment", "INTEGER"), ("t_equipment", "INTEGER"),
    ("ct_buy", "TEXT"), ("t_buy", "TEXT"),
]
PLAYER_MATCH_COLS = [
    ("steamid", "TEXT"), ("name", "TEXT"), ("team", "TEXT"), ("team_name", "TEXT"), ("start_side", "TEXT"),
    ("last_side", "TEXT"), ("result", "TEXT"), ("team_score", "INTEGER"), ("opp_score", "INTEGER"),
    ("rounds_played", "INTEGER"), ("rounds_won", "INTEGER"), ("rounds_ct", "INTEGER"), ("rounds_t", "INTEGER"),
    ("kills", "INTEGER"), ("deaths", "INTEGER"), ("assists", "INTEGER"), ("flash_assists", "INTEGER"),
    ("headshot_kills", "INTEGER"), ("headshot_pct", "REAL"), ("opening_kills", "INTEGER"),
    ("opening_deaths", "INTEGER"), ("traded_deaths", "INTEGER"), ("trade_kills", "INTEGER"),
    ("multikill_2k", "INTEGER"), ("multikill_3k", "INTEGER"), ("multikill_4k", "INTEGER"), ("multikill_5k", "INTEGER"),
    ("mk_2k", "INTEGER"), ("mk_3k", "INTEGER"), ("mk_4k", "INTEGER"), ("mk_5k", "INTEGER"),
    ("kast", "REAL"), ("adr", "REAL"), ("rating", "REAL"), ("damage", "INTEGER"), ("adr_calc", "REAL"),
    ("kast_calc", "REAL"), ("clutches_played", "INTEGER"), ("clutches_won", "INTEGER"),
    ("clutch_1v1", "INTEGER"), ("clutch_1v2", "INTEGER"), ("clutch_1v3", "INTEGER"), ("clutch_1v4", "INTEGER"),
    ("clutch_1v5", "INTEGER"), ("utility_damage", "INTEGER"), ("flashes_thrown", "INTEGER"),
    ("enemies_flashed", "INTEGER"), ("flash_duration_dealt", "REAL"), ("spent", "INTEGER"), ("stats_source", "TEXT"),
]
PLAYER_ROUND_COLS = [
    ("round_num", "INTEGER"), ("steamid", "TEXT"), ("team", "TEXT"), ("side", "TEXT"), ("kills", "INTEGER"),
    ("deaths", "INTEGER"), ("assists", "INTEGER"), ("damage", "INTEGER"), ("util_damage", "INTEGER"),
    ("headshots", "INTEGER"), ("survived", "INTEGER"), ("traded", "INTEGER"), ("trade_kills", "INTEGER"),
    ("kast", "INTEGER"), ("opening_kill", "INTEGER"), ("opening_death", "INTEGER"), ("won", "INTEGER"),
    ("clutch_vs", "INTEGER"), ("clutch_won", "INTEGER"), ("spent", "INTEGER"),
]
KILL_COLS = [
    ("round_num", "INTEGER"), ("tick", "INTEGER"), ("attacker_steamid", "TEXT"), ("attacker_name", "TEXT"),
    ("attacker_side", "TEXT"), ("victim_steamid", "TEXT"), ("victim_name", "TEXT"), ("victim_side", "TEXT"),
    ("assister_steamid", "TEXT"), ("weapon", "TEXT"), ("headshot", "INTEGER"), ("noscope", "INTEGER"),
    ("thrusmoke", "INTEGER"), ("penetrated", "INTEGER"), ("attackerblind", "INTEGER"), ("is_trade", "INTEGER"),
    ("victim_traded", "INTEGER"), ("is_teamkill", "INTEGER"), ("attacker_x", "REAL"), ("attacker_y", "REAL"),
    ("victim_x", "REAL"), ("victim_y", "REAL"),
]
WEAPON_COLS = [
    ("steamid", "TEXT"), ("weapon", "TEXT"), ("shots", "INTEGER"), ("hits", "INTEGER"), ("damage", "INTEGER"),
    ("kills", "INTEGER"), ("headshots", "INTEGER"),
]
HIGHLIGHT_COLS = [
    ("round_num", "INTEGER"), ("steamid", "TEXT"), ("name", "TEXT"), ("kind", "TEXT"), ("tick_start", "INTEGER"),
    ("tick_end", "INTEGER"), ("score", "REAL"), ("title", "TEXT"), ("key_ticks", "TEXT"), ("evidence", "TEXT"),
]
MATCH_NEW_COLS = [
    ("demo_sha256", "TEXT"), ("build_num", "INTEGER"), ("awpy_version", "TEXT"), ("parser_version", "INTEGER"),
    ("derive_version", "INTEGER DEFAULT 0"), ("played_at", "REAL"), ("keep_demo", "INTEGER DEFAULT 0"),
    ("demo_managed", "INTEGER DEFAULT 0"), ("team_a_score", "INTEGER"), ("team_b_score", "INTEGER"),
    ("team_a_name", "TEXT"), ("team_b_name", "TEXT"), ("team_a_start_side", "TEXT"), ("warnings", "TEXT"),
    ("header", "TEXT"),
]

LEGACY_SCHEMA = """
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


def _table(name: str, cols: list[tuple[str, str]], pk: str, prefix: str = "match_id TEXT NOT NULL") -> str:
    body = ",\n    ".join([prefix] + [f"{c} {t}" for c, t in cols] + [f"PRIMARY KEY ({pk})"])
    return f"CREATE TABLE IF NOT EXISTS {name} (\n    {body}\n);"


def _migration_2(conn: sqlite3.Connection) -> None:
    have = {r[1] for r in conn.execute("PRAGMA table_info(matches)")}
    for col, typ in MATCH_NEW_COLS:
        if col not in have:
            conn.execute(f"ALTER TABLE matches ADD COLUMN {col} {typ}")
    if "codec" not in {r[1] for r in conn.execute("PRAGMA table_info(datasets)")}:
        conn.execute("ALTER TABLE datasets ADD COLUMN codec TEXT DEFAULT 'json'")
    conn.executescript("\n".join([
        _table("rounds", ROUND_COLS, "match_id, round_num"),
        _table("player_match", PLAYER_MATCH_COLS, "match_id, steamid"),
        _table("player_round", PLAYER_ROUND_COLS, "match_id, round_num, steamid"),
        _table("kills", KILL_COLS, "match_id, idx", prefix="match_id TEXT NOT NULL,\n    idx INTEGER NOT NULL"),
        _table("player_weapon", WEAPON_COLS, "match_id, steamid, weapon"),
        _table("highlights", HIGHLIGHT_COLS, "match_id, idx", prefix="match_id TEXT NOT NULL,\n    idx INTEGER NOT NULL"),
        """
        CREATE TABLE IF NOT EXISTS parse_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id TEXT NOT NULL, kind TEXT NOT NULL, at REAL NOT NULL,
            parser_version INTEGER, derive_version INTEGER, awpy_version TEXT, sha256 TEXT,
            seconds REAL, row_counts TEXT, timings TEXT, dataset_errors TEXT, warnings TEXT
        );
        CREATE TABLE IF NOT EXISTS import_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, file_name TEXT, file_path TEXT,
            sha256 TEXT, status TEXT NOT NULL, match_id TEXT, error TEXT
        );
        CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT, steamid TEXT NOT NULL, created_at REAL NOT NULL,
            engine_version INTEGER, prompt_version INTEGER, provider TEXT, model TEXT,
            scope TEXT, findings TEXT, narrative TEXT, error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pm_steamid ON player_match(steamid);
        CREATE INDEX IF NOT EXISTS idx_pr_steamid ON player_round(steamid, match_id);
        CREATE INDEX IF NOT EXISTS idx_pw_steamid ON player_weapon(steamid);
        CREATE INDEX IF NOT EXISTS idx_matches_sha ON matches(demo_sha256);
        CREATE INDEX IF NOT EXISTS idx_matches_played ON matches(played_at);
        CREATE INDEX IF NOT EXISTS idx_hl_steamid ON highlights(steamid);
        CREATE INDEX IF NOT EXISTS idx_runs_match ON parse_runs(match_id);
        """,
    ]))
    # 旧库的场次：played_at 先用导入时间兜底，derive_version=0 让后台补算派生层
    conn.execute("UPDATE matches SET played_at = created_at WHERE played_at IS NULL")
    conn.execute("UPDATE matches SET derive_version = 0 WHERE derive_version IS NULL")


MIGRATIONS = {
    1: lambda conn: conn.executescript(LEGACY_SCHEMA),
    2: _migration_2,
}


def encode_payload(value: Any) -> bytes:
    return zlib.compress(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 6)


def decode_payload(payload: Any, codec: str | None) -> Any:
    if codec == "zjson":
        return json.loads(zlib.decompress(payload).decode("utf-8"))
    if isinstance(payload, bytes):
        payload = payload.decode("utf-8")
    return json.loads(payload)


def _insert(conn: sqlite3.Connection, table: str, cols: list[tuple[str, str]], rows: Iterable[dict],
            fixed: dict[str, Any]) -> None:
    names = list(fixed) + [c for c, _ in cols]
    sql = f"INSERT INTO {table} ({', '.join(names)}) VALUES ({', '.join('?' * len(names))})"
    values = list(fixed.values())
    conn.executemany(sql, [values + [_cell(row.get(c)) for c, _ in cols] for row in rows])


def _cell(value: Any) -> Any:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return value


class Store:
    def __init__(self, db_path: str | os.PathLike, backup_dir: str | os.PathLike | None = None):
        self.db_path = str(db_path)
        os.makedirs(os.path.dirname(os.path.abspath(self.db_path)), exist_ok=True)
        self.backup_dir = Path(backup_dir) if backup_dir else Path(self.db_path).parent / "backups"
        self._write_lock = threading.Lock()
        self.migration_note: str | None = None
        self._migrate()

    # ---------------------------------------------------------------- 连接与迁移

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        """写操作串行化：两个解析线程同时落库时避免 database is locked。"""
        with self._write_lock, self.conn() as conn:
            yield conn

    def schema_version(self) -> int:
        with self.conn() as conn:
            return self._version(conn)

    @staticmethod
    def _version(conn: sqlite3.Connection) -> int:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "schema_meta" in tables:
            row = conn.execute("SELECT MAX(version) FROM schema_meta").fetchone()
            return int(row[0] or 0)
        return 1 if "matches" in tables else 0

    def _migrate(self) -> None:
        with self.conn() as conn:
            current = self._version(conn)
            has_data = current >= 1 and conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0] > 0
        if current >= SCHEMA_VERSION:
            return
        if has_data:
            self.migration_note = f"已从 v{current} 升级到 v{SCHEMA_VERSION}，升级前备份：{self.backup(tag=f'v{current}')}"
        with self.write() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER PRIMARY KEY, applied_at REAL, note TEXT)")
            for version in range(current + 1, SCHEMA_VERSION + 1):
                MIGRATIONS[version](conn)
                conn.execute("INSERT OR REPLACE INTO schema_meta VALUES (?,?,?)", (version, time.time(), None))
            if current == 1:
                conn.execute("INSERT OR REPLACE INTO schema_meta VALUES (1, ?, 'legacy baseline')", (time.time(),))

    def backup(self, dest: str | os.PathLike | None = None, tag: str = "manual") -> str:
        """用 SQLite 在线备份 API 拷一份一致的快照（库在使用中也安全）。"""
        if dest is None:
            self.backup_dir.mkdir(parents=True, exist_ok=True)
            dest = self.backup_dir / f"panel-{tag}-{time.strftime('%Y%m%d-%H%M%S')}.db"
        src = self._connect()
        try:
            out = sqlite3.connect(str(dest))
            try:
                src.backup(out)
            finally:
                out.close()
        finally:
            src.close()
        return str(dest)

    # ---------------------------------------------------------------- 写入

    def save_match(self, parsed: dict, *, file_name: str, file_path: str | None, sha256: str | None = None,
                   played_at: float | None = None, managed: bool = False, parser_version: int | None = None,
                   awpy_version: str | None = None, match_id: str | None = None) -> str:
        """写入一场比赛的原始层（matches + datasets）。派生层由 replace_derived 写入。"""
        match_id = match_id or uuid.uuid4().hex[:16]
        meta = parsed.get("meta") or {}
        datasets = parsed.get("datasets") or {}
        rounds = datasets.get("rounds") or []
        ct = sum(1 for r in rounds if r.get("winner_side") == "counter-terrorist")
        t = sum(1 for r in rounds if r.get("winner_side") == "terrorist")
        size = os.path.getsize(file_path) if file_path and os.path.exists(file_path) else None
        now = time.time()
        with self.write() as conn:
            conn.execute(
                "INSERT INTO matches (id, file_name, file_path, file_size, map_name, server_name, tick_rate,"
                " playback_time, parse_seconds, ct_score, t_score, round_count, created_at, demo_sha256, build_num,"
                " awpy_version, parser_version, derive_version, played_at, demo_managed, header)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)",
                (match_id, file_name, file_path, size, meta.get("map_name"), meta.get("server_name"),
                 meta.get("tick_rate"), meta.get("playback_time"), parsed.get("parse_seconds"), ct, t, len(rounds),
                 now, sha256, meta.get("build_num"), awpy_version, parser_version, played_at or now, int(managed),
                 json.dumps(parsed.get("header") or {}, ensure_ascii=False, default=str)),
            )
            self._write_datasets(conn, match_id, datasets)
        return match_id

    def replace_raw(self, match_id: str, parsed: dict, *, parser_version: int | None, awpy_version: str | None,
                    sha256: str | None) -> None:
        """重解析：替换原始层，派生层随后由 replace_derived 重写。"""
        meta = parsed.get("meta") or {}
        datasets = parsed.get("datasets") or {}
        rounds = datasets.get("rounds") or []
        with self.write() as conn:
            conn.execute("DELETE FROM datasets WHERE match_id = ?", (match_id,))
            self._write_datasets(conn, match_id, datasets)
            conn.execute(
                "UPDATE matches SET map_name=?, server_name=?, tick_rate=?, playback_time=?, parse_seconds=?,"
                " ct_score=?, t_score=?, round_count=?, build_num=?, awpy_version=?, parser_version=?, demo_sha256=?,"
                " header=?, derive_version=0 WHERE id=?",
                (meta.get("map_name"), meta.get("server_name"), meta.get("tick_rate"), meta.get("playback_time"),
                 parsed.get("parse_seconds"),
                 sum(1 for r in rounds if r.get("winner_side") == "counter-terrorist"),
                 sum(1 for r in rounds if r.get("winner_side") == "terrorist"), len(rounds), meta.get("build_num"),
                 awpy_version, parser_version, sha256, json.dumps(parsed.get("header") or {}, ensure_ascii=False,
                                                                  default=str), match_id),
            )

    @staticmethod
    def _write_datasets(conn: sqlite3.Connection, match_id: str, datasets: dict[str, list]) -> None:
        conn.executemany(
            "INSERT OR REPLACE INTO datasets (match_id, name, payload, codec) VALUES (?,?,?, 'zjson')",
            [(match_id, name, encode_payload(rows)) for name, rows in datasets.items()],
        )

    def replace_derived(self, match_id: str, derived, highlights: list[dict], derive_version: int) -> None:
        teams = derived.teams or {}
        a, b = teams.get("A") or {}, teams.get("B") or {}
        with self.write() as conn:
            for table in ("rounds", "player_match", "player_round", "kills", "player_weapon", "highlights"):
                conn.execute(f"DELETE FROM {table} WHERE match_id = ?", (match_id,))
            fixed = {"match_id": match_id}
            _insert(conn, "rounds", ROUND_COLS, derived.rounds, fixed)
            _insert(conn, "player_match", PLAYER_MATCH_COLS, derived.player_match, fixed)
            _insert(conn, "player_round", PLAYER_ROUND_COLS, derived.player_round, fixed)
            _insert(conn, "player_weapon", WEAPON_COLS, derived.player_weapon, fixed)
            conn.executemany(
                f"INSERT INTO kills (match_id, idx, {', '.join(c for c, _ in KILL_COLS)})"
                f" VALUES (?, ?, {', '.join('?' * len(KILL_COLS))})",
                [[match_id, i] + [_cell(k.get(c)) for c, _ in KILL_COLS] for i, k in enumerate(derived.kills)],
            )
            conn.executemany(
                f"INSERT INTO highlights (match_id, idx, {', '.join(c for c, _ in HIGHLIGHT_COLS)})"
                f" VALUES (?, ?, {', '.join('?' * len(HIGHLIGHT_COLS))})",
                [[match_id, i] + [_cell(h.get(c)) for c, _ in HIGHLIGHT_COLS] for i, h in enumerate(highlights)],
            )
            conn.execute(
                "UPDATE matches SET team_a_score=?, team_b_score=?, team_a_name=?, team_b_name=?, team_a_start_side=?,"
                " warnings=?, derive_version=? WHERE id=?",
                (a.get("score"), b.get("score"), a.get("name"), b.get("name"), a.get("start_side"),
                 json.dumps(derived.warnings, ensure_ascii=False), derive_version, match_id),
            )

    def update_match(self, match_id: str, **fields: Any) -> None:
        allowed = {"keep_demo", "file_path", "file_size", "demo_sha256", "played_at", "demo_managed"}
        bad = set(fields) - allowed
        if bad:
            raise ValueError(f"不可更新的字段：{sorted(bad)}")
        if not fields:
            return
        sets = ", ".join(f"{k} = ?" for k in fields)
        with self.write() as conn:
            conn.execute(f"UPDATE matches SET {sets} WHERE id = ?", [*map(_cell, fields.values()), match_id])

    def record_run(self, match_id: str, kind: str, **info: Any) -> None:
        with self.write() as conn:
            conn.execute(
                "INSERT INTO parse_runs (match_id, kind, at, parser_version, derive_version, awpy_version, sha256,"
                " seconds, row_counts, timings, dataset_errors, warnings) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (match_id, kind, time.time(), info.get("parser_version"), info.get("derive_version"),
                 info.get("awpy_version"), info.get("sha256"), info.get("seconds"),
                 *(json.dumps(info.get(k) or {}, ensure_ascii=False) for k in ("row_counts", "timings",
                                                                               "dataset_errors", "warnings"))),
            )

    def log_import(self, status: str, *, file_name: str | None = None, file_path: str | None = None,
                   sha256: str | None = None, match_id: str | None = None, error: str | None = None) -> None:
        with self.write() as conn:
            conn.execute(
                "INSERT INTO import_log (at, file_name, file_path, sha256, status, match_id, error) VALUES (?,?,?,?,?,?,?)",
                (time.time(), file_name, file_path, sha256, status, match_id, error),
            )

    def delete_match(self, match_id: str) -> None:
        with self.write() as conn:
            conn.execute("DELETE FROM matches WHERE id = ?", (match_id,))
            for table in ("datasets", "extra", "rounds", "player_match", "player_round", "kills", "player_weapon",
                          "highlights", "parse_runs"):
                conn.execute(f"DELETE FROM {table} WHERE match_id = ?", (match_id,))

    # ---------------------------------------------------------------- 读取

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self.conn() as conn:
            return [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def list_matches(self) -> list[dict]:
        return self.query(
            "SELECT id, file_name, file_path, map_name, server_name, ct_score, t_score, round_count, playback_time,"
            " parse_seconds, file_size, created_at, played_at, demo_sha256, keep_demo, demo_managed,"
            " team_a_score, team_b_score, team_a_name, team_b_name, team_a_start_side, derive_version,"
            " parser_version, awpy_version, build_num"
            " FROM matches ORDER BY COALESCE(played_at, created_at) DESC, created_at DESC"
        )

    def get_match(self, match_id: str) -> dict | None:
        row = self.query_one("SELECT * FROM matches WHERE id = ?", (match_id,))
        if row:
            for key in ("warnings", "header"):
                try:
                    row[key] = json.loads(row[key]) if row.get(key) else ([] if key == "warnings" else {})
                except ValueError:
                    pass
        return row

    def find_by_sha(self, sha256: str) -> dict | None:
        return self.query_one("SELECT id, file_name FROM matches WHERE demo_sha256 = ? LIMIT 1", (sha256,))

    def get_dataset(self, match_id: str, name: str) -> list[dict]:
        with self.conn() as conn:
            row = conn.execute("SELECT payload, codec FROM datasets WHERE match_id = ? AND name = ?",
                               (match_id, name)).fetchone()
        return decode_payload(row["payload"], row["codec"]) if row else []

    def get_datasets(self, match_id: str) -> dict[str, list[dict]]:
        with self.conn() as conn:
            rows = conn.execute("SELECT name, payload, codec FROM datasets WHERE match_id = ?", (match_id,)).fetchall()
        return {r["name"]: decode_payload(r["payload"], r["codec"]) for r in rows}

    def dataset_names(self, match_id: str) -> list[str]:
        return [r["name"] for r in self.query("SELECT name FROM datasets WHERE match_id = ?", (match_id,))]

    def get_extra(self, match_id: str, name: str) -> Any:
        row = self.query_one("SELECT payload FROM extra WHERE match_id = ? AND name = ?", (match_id, name))
        return json.loads(row["payload"]) if row else None

    def stale_matches(self, derive_version: int) -> list[str]:
        return [r["id"] for r in self.query(
            "SELECT id FROM matches WHERE COALESCE(derive_version, 0) < ? ORDER BY created_at", (derive_version,))]

    def runs(self, match_id: str) -> list[dict]:
        rows = self.query("SELECT * FROM parse_runs WHERE match_id = ? ORDER BY id DESC", (match_id,))
        for row in rows:
            for key in ("row_counts", "timings", "dataset_errors", "warnings"):
                row[key] = json.loads(row[key]) if row.get(key) else {}
        return rows

    # ---------------------------------------------------------------- 键值设置

    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self.query_one("SELECT value FROM app_settings WHERE key = ?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        with self.write() as conn:
            conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
                         (key, json.dumps(value, ensure_ascii=False)))
