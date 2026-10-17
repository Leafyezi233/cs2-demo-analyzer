import os
import re
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.config import Config
from app.devtools import synth
from app.main import create_app

MAGIC = b"PBDEMS2\x00"
HERO = synth.steamid(1)
MAPS = ["de_mirage", "de_inferno", "de_mirage", "de_nuke", "de_mirage", "de_inferno", "de_nuke", "de_mirage"]


def fake_parse(path, progress=None):
    seed = int(re.search(r"m(\d+)", os.path.basename(path)).group(1))
    parsed, _ = synth.make_match(seed=seed, map_name=MAPS[seed % len(MAPS)], hero_boost=0.1 * seed)
    return parsed


@pytest.fixture
def env(tmp_path):
    cfg = Config(data_dir=tmp_path / "data", open_browser=False, extra_scan_dirs=(str(tmp_path / "steam"),))
    app = create_app(cfg, parse_fn=fake_parse)
    with TestClient(app) as client:
        yield client, app.state.ctx, tmp_path


def upload(client, ctx, seed, name=None, wait=True):
    body = MAGIC + f"demo-{seed}".encode()
    r = client.post(f"/api/demos?name={name or f'm{seed}.dem'}&mtime={1_700_000_000_000 + seed * 86_400_000}",
                    content=body)
    assert r.status_code == 200, r.text
    data = r.json()
    if wait and data.get("task_id"):
        task = ctx.jobs.wait(data["task_id"], 20)
        assert task["status"] == "done", task
        data["match_id"] = task["match_id"]
    return data


def test_upload_parse_dedupe_and_reject(env):
    client, ctx, _ = env
    first = upload(client, ctx, 1)
    assert first["duplicate"] is False
    again = upload(client, ctx, 1, name="renamed.dem")
    assert again["duplicate"] is True and again["match_id"] == first["match_id"]
    # 同名但内容不同：不覆盖旧文件
    other = upload(client, ctx, 2, name="m1.dem")
    files = sorted(os.listdir(ctx.config.demo_dir))
    assert "m1.dem" in files and "m1 (2).dem" in files and other["match_id"] != first["match_id"]

    assert client.post("/api/demos?name=old.dem", content=b"HL2DEMO\x00xxxx").status_code == 400
    assert client.post("/api/demos?name=x.txt", content=MAGIC).status_code == 400
    assert client.post("/api/demos?name=e.dem", content=b"").status_code == 400
    assert not list((ctx.config.demo_dir / ".incoming").iterdir())

    matches = client.get("/api/matches").json()
    assert len(matches) == 2
    assert matches[0]["played_at"] > matches[1]["played_at"]   # 按比赛时间倒序


def test_match_endpoints(env):
    client, ctx, _ = env
    mid = upload(client, ctx, 3)["match_id"]
    m = client.get(f"/api/matches/{mid}").json()
    assert m["team_a_score"] + m["team_b_score"] == m["round_count"]
    assert m["demo_present"] is True and m["runs"]

    players = client.get(f"/api/matches/{mid}/players").json()
    assert len(players) == 10
    assert {"ct", "t"} <= set(players[0]["split"])
    assert players[0]["result"] in ("W", "L", "T")

    rounds = client.get(f"/api/matches/{mid}/rounds").json()
    assert rounds["timeline"][-1]["score_a"] == m["team_a_score"]

    hl = client.get(f"/api/matches/{mid}/highlights").json()
    assert hl and isinstance(hl[0]["key_ticks"], list)

    heat = client.get(f"/api/matches/{mid}/heatmap?type=kills&steamid={HERO}").json()
    assert 0 < heat["filtered"] < heat["total"]
    heat_r1 = client.get(f"/api/matches/{mid}/heatmap?type=kills&round_num=1").json()
    assert heat_r1["filtered"] <= 9
    assert client.get(f"/api/matches/{mid}/heatmap?round_num=99").status_code == 404

    assert client.get(f"/api/matches/{mid}/weapons").json()["weapons"]
    cmp_ = client.get(f"/api/compare?ids={mid}").json()
    assert cmp_["matches"][0]["players"][0]["steamid"]
    assert client.get("/api/matches/nope/players").status_code == 404


def test_cross_match_stats_and_insights(env):
    client, ctx, _ = env
    for seed in range(1, 9):
        upload(client, ctx, seed)
    roster = client.get("/api/roster").json()
    assert roster[0]["steamid"] == HERO and roster[0]["count"] == 8

    summ = client.get(f"/api/players/summary?steamids={HERO},{synth.steamid(2)}").json()
    hero = summ["accounts"][0]
    assert hero["games"] == 8 and hero["w"] + hero["l"] + hero["t"] == 8
    assert set(hero["sides"]) == {"counter-terrorist", "terrorist"}
    assert hero["sides"]["counter-terrorist"]["rounds"] + hero["sides"]["terrorist"]["rounds"] == hero["rounds"]
    assert summ["combined"]["games"] == 16

    last3 = client.get(f"/api/players/summary?steamids={HERO}&last=3").json()["accounts"][0]
    assert last3["games"] == 3 and last3["prev"]["games"] == 3

    tl = client.get(f"/api/players/{HERO}/timeline").json()
    assert [t["played_at"] for t in tl] == sorted(t["played_at"] for t in tl)

    for dim in ("side", "map", "map_side", "weapon", "economy"):
        rows = client.get(f"/api/players/{HERO}/breakdown?dim={dim}").json()["rows"]
        assert rows, dim
    maps = {r["map_name"]: r for r in client.get(f"/api/players/{HERO}/breakdown?dim=map").json()["rows"]}
    assert maps["de_mirage"]["games"] == 4 and maps["de_mirage"]["sample"] == "ok"
    assert client.get(f"/api/players/{HERO}/breakdown?dim=nope").status_code == 422
    on_map = client.get(f"/api/players/summary?steamids={HERO}&map=de_nuke").json()["accounts"][0]
    assert on_map["games"] == 2 and on_map["sample"] == "low"

    ins = client.get(f"/api/players/{HERO}/insights").json()
    assert ins["summary"]["games"] == 8 and ins["findings"]
    assert all({"id", "kind", "severity", "title", "detail"} <= set(f) for f in ins["findings"])
    again = client.get(f"/api/players/{HERO}/insights").json()
    assert again == ins   # 规则层可复现

    hl = client.get(f"/api/players/{HERO}/highlights?limit=5").json()
    assert len(hl) <= 5 and all(h["steamid"] == HERO for h in hl)


def test_report_offline_manual_and_failure(env):
    client, ctx, _ = env
    for seed in range(1, 5):
        upload(client, ctx, seed)
    rep = client.post(f"/api/players/{HERO}/report", json={}).json()
    assert rep["provider"] == "none" and rep["narrative"] and rep["error"] is None
    manual = client.post(f"/api/players/{HERO}/report", json={"provider": "manual"}).json()
    assert manual["narrative"] is None and "规则引擎" in manual["prompt"]

    r = client.put("/api/settings/ai", json={"provider": "openai", "base_url": "http://127.0.0.1:9/v1",
                                             "api_key": "sk-test-1234567890", "timeout": 5})
    assert r.json()["api_key_set"] is True and "api_key" not in r.json()
    failed = client.post(f"/api/players/{HERO}/report", json={}).json()
    assert failed["error"] and failed["fallback"]                 # 接口不可达：给出错误 + 离线兜底文字
    assert client.get("/api/settings").json()["ai"]["api_key_hint"].startswith("sk-")
    assert len(client.get(f"/api/players/{HERO}/reports").json()) == 3
    assert client.put("/api/settings/ai", json={"provider": "bogus"}).status_code == 400


def test_demo_lifecycle(env):
    client, ctx, _ = env
    mid = upload(client, ctx, 5)["match_id"]
    assert client.patch(f"/api/matches/{mid}", json={"keep_demo": True}).json()["keep_demo"] is True
    assert client.delete(f"/api/matches/{mid}/demo").status_code == 409
    client.patch(f"/api/matches/{mid}", json={"keep_demo": False})
    freed = client.delete(f"/api/matches/{mid}/demo").json()
    assert freed["freed_bytes"] > 0
    m = client.get(f"/api/matches/{mid}").json()
    assert m["demo_present"] is False
    # 统计照常，回放给出明确提示
    assert client.get(f"/api/matches/{mid}/players").status_code == 200
    r = client.get(f"/api/matches/{mid}/replay/1")
    assert r.status_code == 410 and "回收" in r.json()["detail"]
    assert client.post(f"/api/matches/{mid}/reparse").status_code == 410

    ov = client.get("/api/stats/overview").json()
    assert ov["matches"] == 1 and ov["demos_missing"] == 1 and ov["storage"]["db_bytes"] > 0

    client.put("/api/settings/lifecycle", json={"recycle_days": 1})
    mid2 = upload(client, ctx, 6)["match_id"]
    ctx.store.query("SELECT 1")
    with ctx.store.write() as conn:
        conn.execute("UPDATE matches SET created_at = created_at - 5 * 86400 WHERE id = ?", (mid2,))
    assert client.get("/api/stats/overview").json()["recyclable"] == 1
    assert client.post("/api/maintenance/recycle", json={}).status_code == 400
    assert client.post("/api/maintenance/recycle", json={"confirm": True}).json()["recycled"] == 1

    res = client.delete(f"/api/matches/{mid2}")
    assert res.json()["deleted"] == mid2


def test_external_demo_never_deleted(env):
    client, ctx, tmp_path = env
    steam = tmp_path / "steam"
    steam.mkdir()
    demo = steam / "m7.dem"
    demo.write_bytes(MAGIC + b"external")
    scan = client.post("/api/demos/scan").json()
    assert scan["total"] == 1 and scan["found"][0]["match_id"] is None
    task_id = client.post("/api/demos/local", params={"path": str(demo)}).json()["task_id"]
    mid = ctx.jobs.wait(task_id, 20)["match_id"]
    assert client.post("/api/demos/scan").json()["found"][0]["match_id"] == mid
    assert client.delete(f"/api/matches/{mid}/demo").status_code == 400
    client.delete(f"/api/matches/{mid}")
    assert demo.exists()


def test_export_rederive_and_health(env):
    client, ctx, tmp_path = env
    upload(client, ctx, 2)
    r = client.get("/api/export/db")
    assert r.status_code == 200 and r.content[:15] == b"SQLite format 3"
    out = tmp_path / "exported.db"
    out.write_bytes(r.content)
    assert sqlite3.connect(out).execute("SELECT COUNT(*) FROM player_match").fetchone()[0] == 10

    task = client.post("/api/maintenance/rederive", json={"all": True}).json()
    assert ctx.jobs.wait(task["task_id"], 20)["result"]["done"] == 1
    h = client.get("/api/health").json()
    assert h["ok"] and h["schema_version"] >= 2


def test_local_only_guard(env):
    client, _ctx, _ = env
    assert client.post("/api/maintenance/backup", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 403
    assert client.post("/api/maintenance/backup", headers={"Origin": "http://127.0.0.1:8765"}).status_code == 200


def test_index_served(env):
    client, _ctx, _ = env
    r = client.get("/")
    assert r.status_code == 200 and "CS2" in r.text
