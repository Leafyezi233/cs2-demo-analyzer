import json
import sqlite3
import time

import pytest

from app import ingest
from app.analysis.derive import DERIVE_VERSION
from app.devtools import synth
from app.store import LEGACY_SCHEMA, SCHEMA_VERSION, Store


def fake_parse_factory(parsed):
    def fake_parse(path, progress=None):
        if progress:
            progress("解析", 0.5)
        return parsed
    return fake_parse


def write_demo(tmp_path, name="a.dem", content=b"PBDEMS2\0fake"):
    path = tmp_path / name
    path.write_bytes(content)
    return str(path)


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "panel.db")


def test_fresh_db_is_current_version(store):
    assert store.schema_version() == SCHEMA_VERSION
    assert store.migration_note is None


def test_import_derive_and_dedupe(store, tmp_path):
    parsed, truth = synth.make_match(seed=1)
    demo = write_demo(tmp_path)
    res = ingest.import_demo(store, demo, parse_fn=fake_parse_factory(parsed))
    assert res["duplicate"] is False
    mid = res["match_id"]
    m = store.get_match(mid)
    assert (m["team_a_score"], m["team_b_score"]) == (truth["score"]["A"], truth["score"]["B"])
    assert m["derive_version"] == DERIVE_VERSION and m["demo_sha256"]
    assert len(store.query("SELECT * FROM player_match WHERE match_id=?", (mid,))) == 10
    assert store.get_dataset(mid, "rounds") == parsed["datasets"]["rounds"]   # 压缩存档可还原
    kinds = [r["kind"] for r in store.runs(mid)]
    assert kinds == ["derive", "parse"]

    again = ingest.import_demo(store, demo, parse_fn=fake_parse_factory(parsed))
    assert again == {"match_id": mid, "duplicate": True, "file_name": "a.dem"}
    statuses = [r["status"] for r in store.query("SELECT status FROM import_log ORDER BY id")]
    assert statuses == ["ok", "duplicate"]


def test_failed_parse_is_logged(store, tmp_path):
    def boom(path, progress=None):
        raise ValueError("not a demo")
    with pytest.raises(ValueError):
        ingest.import_demo(store, write_demo(tmp_path), parse_fn=boom)
    log = store.query("SELECT status, error FROM import_log")
    assert log == [{"status": "failed", "error": "ValueError: not a demo"}]


def test_legacy_db_upgrade_backs_up_and_backfills(tmp_path):
    db = tmp_path / "panel.db"
    parsed, truth = synth.make_match(seed=4)
    conn = sqlite3.connect(db)
    conn.executescript(LEGACY_SCHEMA)
    conn.execute("INSERT INTO matches (id, file_name, file_path, map_name, tick_rate, ct_score, t_score, round_count,"
                 " created_at) VALUES ('legacy1', 'old.dem', '/nowhere/old.dem', 'de_mirage', 64, 0, 0, 24, ?)",
                 (time.time(),))
    for name, rows in parsed["datasets"].items():
        conn.execute("INSERT INTO datasets VALUES ('legacy1', ?, ?)", (name, json.dumps(rows)))
    conn.commit()
    conn.close()

    store = Store(db)
    assert store.schema_version() == SCHEMA_VERSION
    assert "备份" in store.migration_note
    assert list((tmp_path / "backups").glob("panel-v1-*.db"))
    assert store.stale_matches(DERIVE_VERSION) == ["legacy1"]
    assert store.get_dataset("legacy1", "kills") == parsed["datasets"]["kills"]   # 旧的明文 JSON 仍可读

    result = ingest.rederive(store)
    assert result == {"done": 1, "failed": {}, "total": 1}
    m = store.get_match("legacy1")
    assert (m["team_a_score"], m["team_b_score"]) == (truth["score"]["A"], truth["score"]["B"])
    assert store.stale_matches(DERIVE_VERSION) == []
    # 再次打开不会重复迁移/备份
    assert Store(db).migration_note is None


def test_reparse_requires_demo(store, tmp_path):
    parsed, _ = synth.make_match(seed=2)
    demo = write_demo(tmp_path)
    mid = ingest.import_demo(store, demo, parse_fn=fake_parse_factory(parsed))["match_id"]
    parsed2, truth2 = synth.make_match(seed=9)
    ingest.reparse_match(store, mid, parse_fn=fake_parse_factory(parsed2))
    m = store.get_match(mid)
    assert (m["team_a_score"], m["team_b_score"]) == (truth2["score"]["A"], truth2["score"]["B"])
    (tmp_path / "a.dem").unlink()
    with pytest.raises(FileNotFoundError):
        ingest.reparse_match(store, mid, parse_fn=fake_parse_factory(parsed2))


def test_delete_match_clears_everything(store, tmp_path):
    parsed, _ = synth.make_match(seed=2)
    mid = ingest.import_demo(store, write_demo(tmp_path), parse_fn=fake_parse_factory(parsed))["match_id"]
    store.delete_match(mid)
    for table in ("matches", "datasets", "player_match", "player_round", "kills", "highlights", "player_weapon"):
        col = "id" if table == "matches" else "match_id"
        assert store.query(f"SELECT COUNT(*) AS n FROM {table} WHERE {col}=?", (mid,))[0]["n"] == 0


def test_backup_snapshot(store, tmp_path):
    path = store.backup(tmp_path / "copy.db")
    assert Store(path).schema_version() == SCHEMA_VERSION
