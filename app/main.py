"""CS2 数据面板 —— FastAPI 后端（仅绑定 127.0.0.1）。

启动：python -m app.main  （或由 启动.bat / 启动器调用）
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent.parent
APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = BASE_DIR / "数据"
DEMO_DIR = DATA_DIR / "demos"
DB_PATH = DATA_DIR / "panel.db"
REPLAY_CACHE = DATA_DIR / "replay_cache"
HOST = "127.0.0.1"
PORT = int(os.environ.get("CS2_PANEL_PORT", "8765"))

# 地图资产：优先用包内 mapdata/，其次用户目录；必须在 import awpy 之前设置
_LOCAL_MAPDATA = BASE_DIR / "mapdata"
if _LOCAL_MAPDATA.is_dir():
    os.environ.setdefault("AWPY_DATA_DIR", str(_LOCAL_MAPDATA))

sys.path.insert(0, str(BASE_DIR))
from app import jobs, metrics, parser, replay  # noqa: E402
from app.store import Store  # noqa: E402

DEMO_DIR.mkdir(parents=True, exist_ok=True)
store = Store(str(DB_PATH))

app = FastAPI(title="CS2 数据面板", version="0.1.0")


# --------------------------------------------------------------------------- 解析 worker

def _worker(file_path: str, report) -> dict:
    report("读取 demo 头信息", 0.05)
    parsed = parser.parse(file_path)
    report("计算指标", 0.85)
    rounds = parsed["datasets"].get("rounds", [])
    kills = parsed["datasets"].get("kills", [])
    stats = parsed["datasets"].get("stats", [])

    for row in stats:
        row["rating"] = metrics.approximate_rating(row)
    multi = metrics.multikills(kills, rounds)
    for row in stats:
        row["multikill_calc"] = multi.get(row.get("steamid"), {"2k": 0, "3k": 0, "4k": 0, "5k": 0, "ace": 0})

    extra = {
        "score": metrics.match_score(rounds),
        "computed": {
            "rating_note": "Rating 为社区近似式，非 HLTV 官方值",
            "multikill_note": "多杀由 kills+rounds 独立重算，可与 awpy stats 交叉校验",
        },
    }
    report("写入数据库", 0.94)
    match_id = store.save_match(parsed, os.path.basename(file_path), file_path, extra)
    return {"match_id": match_id, "meta": parsed["meta"], "timings": parsed["timings"]}


# --------------------------------------------------------------------------- API

@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "version": app.version, "mapdata": str(_LOCAL_MAPDATA) if _LOCAL_MAPDATA.is_dir() else None}


@app.get("/api/matches")
def list_matches() -> list[dict]:
    return store.list_matches()


@app.get("/api/matches/{match_id}")
def get_match(match_id: str) -> dict:
    match = store.get_match(match_id)
    if not match:
        raise HTTPException(404, "match not found")
    return {**match, "datasets": store.dataset_names(match_id), "score": store.get_extra(match_id, "score")}


@app.get("/api/matches/{match_id}/players")
def get_players(match_id: str) -> list[dict]:
    stats = store.get_dataset(match_id, "stats")
    if not stats:
        raise HTTPException(404, "no stats for this match")
    players = {p["steamid"]: p for p in store.get_dataset(match_id, "players")}
    out = []
    for row in stats:
        info = players.get(row.get("steamid"), {})
        out.append({**row, "side": info.get("side"), "team_clan_name": info.get("team_clan_name")})
    out.sort(key=lambda r: (r.get("rating") or 0), reverse=True)
    return out


@app.get("/api/matches/{match_id}/rounds")
def get_rounds(match_id: str) -> dict:
    return {
        "rounds": store.get_dataset(match_id, "rounds"),
        "economy": store.get_dataset(match_id, "round_economy"),
    }


@app.get("/api/matches/{match_id}/heatmap")
def get_heatmap(
    match_id: str,
    type: str = Query("kills", pattern="^(kills|deaths|shots)$"),
    limit: int = 4000,
    round_num: int | None = Query(None, ge=1),
    side: str | None = Query(None, pattern="^(ct|t|counter-terrorist|terrorist)$"),
    weapon: str | None = None,
) -> dict:
    """击杀/死亡/射击点集。

    筛选口径（与 metrics.multikills 一致，用 official_end_tick 归回合）：
    - round_num：按 official_end_tick 归属；落在所有回合区间外的点会被排除。
    - side：kills/deaths 看 attacker_side，shots 看 side。
    - weapon：kills 的 weapon 无前缀（ak47），shots 的 weapon 带 weapon_ 前缀（weapon_ak47），
      因此两边都做一次去前缀归一化后比较。
    """
    source = {"kills": "kills", "deaths": "kills", "shots": "shots"}[type]
    rows = store.get_dataset(match_id, source)
    total_before = len(rows)

    rounds = store.get_dataset(match_id, "rounds") if round_num is not None else []
    span = None
    if round_num is not None:
        for r in rounds:
            if r.get("round_num") == round_num:
                span = (r.get("start_tick"), r.get("official_end_tick") or r.get("end_tick"))
                break
        if span is None:
            raise HTTPException(404, f"没有第 {round_num} 回合")

    want_side = {"ct": "counter-terrorist", "t": "terrorist"}.get(side or "", side)
    want_weapon = (weapon or "").removeprefix("weapon_")

    def keep(row: dict) -> bool:
        if span is not None:
            tick = row.get("tick")
            if tick is None or tick < span[0] or tick > span[1]:
                return False
        if want_side:
            row_side = row.get("attacker_side") if type != "shots" else row.get("side")
            if row_side != want_side:
                return False
        if want_weapon:
            if (row.get("weapon") or "").removeprefix("weapon_") != want_weapon:
                return False
        return True

    filtered = [r for r in rows if keep(r)] if (span is not None or want_side or want_weapon) else rows
    points = metrics.heatmap_points(filtered, type)
    if len(points) > limit:
        step = len(points) / limit
        points = [points[int(i * step)] for i in range(limit)]
    match = store.get_match(match_id) or {}
    return {
        "map_name": match.get("map_name"),
        "type": type,
        "points": points,
        "total": total_before,
        "filtered": len(filtered),
        "filter": {"round_num": round_num, "side": side, "weapon": weapon},
    }


@app.get("/api/matches/{match_id}/weapons")
def get_weapons(match_id: str) -> dict:
    """该场 demo 出现过的武器（已去 weapon_ 前缀并合并两侧口径），供筛选下拉用。"""
    kills = store.get_dataset(match_id, "kills")
    shots = store.get_dataset(match_id, "shots")

    def bump(bucket: dict, raw) -> None:
        name = (raw or "").removeprefix("weapon_")
        if name:
            bucket[name] = bucket.get(name, 0) + 1

    kill_counts: dict[str, int] = {}
    for row in kills:
        bump(kill_counts, row.get("weapon"))
    shot_counts: dict[str, int] = {}
    for row in shots:
        bump(shot_counts, row.get("weapon"))
    names = sorted(set(kill_counts) | set(shot_counts), key=lambda n: -(kill_counts.get(n, 0) + shot_counts.get(n, 0)))
    return {
        "weapons": [{"name": n, "kills": kill_counts.get(n, 0), "shots": shot_counts.get(n, 0)} for n in names],
    }


@app.get("/api/matches/{match_id}/replay/{round_num}")
def get_replay(match_id: str, round_num: int, every: int = Query(replay.EVERY_DEFAULT)) -> dict:
    """取某回合的走位回放轨迹（落盘缓存，见 app/replay.py）。"""
    match = store.get_match(match_id)
    if not match:
        raise HTTPException(404, "match not found")
    rounds = store.get_dataset(match_id, "rounds")
    target = next((r for r in rounds if r.get("round_num") == round_num), None)
    if target is None:
        raise HTTPException(404, f"没有第 {round_num} 回合")
    demo_path = match.get("file_path")
    if not demo_path or not os.path.isfile(demo_path):
        raise HTTPException(410, f"原始 demo 已不在原路径，无法生成回放：{demo_path}")
    try:
        data = replay.build(demo_path, target, every, REPLAY_CACHE, match_id, match.get("tick_rate"))
    except FileNotFoundError as exc:
        raise HTTPException(410, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"生成回放失败：{type(exc).__name__}: {exc}")
    data["map_name"] = match.get("map_name")
    data["round"] = target
    return data


@app.delete("/api/matches/{match_id}/replay")
def clear_replay_cache(match_id: str) -> dict:
    """清掉某场比赛的回放缓存（换 demo 或想重算时用）。"""
    import shutil
    path = REPLAY_CACHE / match_id
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    return {"cleared": match_id}


@app.get("/api/compare")
def compare_matches(ids: str = Query(..., description="逗号分隔的 match id，2-8 场")) -> dict:
    """多场对比：返回每场的元信息与玩家统计，前端自行对齐。"""
    wanted = [x.strip() for x in ids.split(",") if x.strip()]
    if not wanted:
        raise HTTPException(400, "至少给一个 match id")
    if len(wanted) > 8:
        raise HTTPException(400, "一次最多对比 8 场")
    out = []
    for mid in wanted:
        match = store.get_match(mid)
        if not match:
            raise HTTPException(404, f"match not found: {mid}")
        stats = store.get_dataset(mid, "stats")
        players = {p.get("steamid"): p for p in store.get_dataset(mid, "players")}
        rows = []
        for row in stats:
            info = players.get(row.get("steamid"), {})
            rows.append({**row, "side": info.get("side"), "team_clan_name": info.get("team_clan_name")})
        rows.sort(key=lambda r: (r.get("rating") or 0), reverse=True)
        rounds = store.get_dataset(mid, "rounds")
        out.append({
            "id": mid,
            "file_name": match.get("file_name"),
            "map_name": match.get("map_name"),
            "ct_score": match.get("ct_score"),
            "t_score": match.get("t_score"),
            "round_count": match.get("round_count"),
            "created_at": match.get("created_at"),
            "score": store.get_extra(mid, "score") or metrics.match_score(rounds),
            "economy": store.get_dataset(mid, "round_economy"),
            "rounds": [{"round_num": r.get("round_num"), "winner_side": r.get("winner_side"), "reason_name": r.get("reason_name")} for r in rounds],
            "players": rows,
        })
    return {"matches": out}


@app.get("/api/maps/{map_name}/info")
def map_info(map_name: str) -> dict:
    """返回雷达图变换参数（世界坐标 -> 像素）与底图可用性。"""
    try:
        import awpy.data as ad
    except Exception as exc:
        raise HTTPException(500, f"awpy.data 不可用：{exc}")
    try:
        table = ad.map_data()          # 注意：map_data(version=None) 返回 {地图名: 坐标表}
    except Exception as exc:
        raise HTTPException(404, f"地图资产缺失（{map_name}）：{exc}")
    data = (table or {}).get(map_name)
    if not isinstance(data, dict):
        raise HTTPException(404, f"map_data.json 里没有 {map_name}")
    radar_ok = False
    try:
        radar_ok = Path(ad.radar_path(map_name)).is_file()
    except Exception:
        radar_ok = False
    # 雷达 PNG 固定 1024x1024（实测 awpy-data 2000930 的 images.zip）
    radar_size = None
    if radar_ok:
        try:
            with open(ad.radar_path(map_name), "rb") as fh:
                head = fh.read(24)
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                import struct
                radar_size = list(struct.unpack(">II", head[16:24]))
        except Exception:
            radar_size = None
    # 与 awpy.plot.world_to_pixel 完全一致的换算：(x - pos_x)/scale, (pos_y - y)/scale
    return {
        "map_name": map_name,
        "scale": data.get("scale"),
        "offset_x": data.get("pos_x", data.get("offset_x")),
        "offset_y": data.get("pos_y", data.get("offset_y")),
        "radar": radar_ok,
        "radar_size": radar_size,
        "raw_keys": sorted(data.keys()) if isinstance(data, dict) else None,
    }


@app.get("/api/maps/{map_name}/radar.png")
def map_radar(map_name: str):
    try:
        import awpy.data as ad
        path = Path(ad.radar_path(map_name))
    except Exception as exc:
        raise HTTPException(404, f"雷达底图缺失（{map_name}）：{exc}")
    if not path.is_file():
        raise HTTPException(404, "radar image not found")
    return FileResponse(str(path), media_type="image/png")


@app.get("/api/matches/{match_id}/dataset/{name}")
def get_dataset(match_id: str, name: str) -> JSONResponse:
    rows = store.get_dataset(match_id, name)
    if not rows and name not in store.dataset_names(match_id):
        raise HTTPException(404, f"dataset {name} not found")
    return JSONResponse(rows)


@app.delete("/api/matches/{match_id}")
def delete_match(match_id: str) -> dict:
    if not store.get_match(match_id):
        raise HTTPException(404, "match not found")
    store.delete_match(match_id)
    return {"deleted": match_id}


@app.post("/api/demos")
async def upload_demo(request: Request) -> dict:
    """接收原始字节流上传（不用 multipart，省掉 python-multipart 依赖）。

    文件名从查询参数 name 或请求头 X-File-Name 取。
    """
    raw_name = request.query_params.get("name") or request.headers.get("x-file-name") or "upload.dem"
    name = os.path.basename(raw_name)
    if not name.lower().endswith(".dem"):
        raise HTTPException(400, "只接受 .dem 文件")
    target = DEMO_DIR / name
    written = 0
    with open(target, "wb") as fh:
        async for chunk in request.stream():
            fh.write(chunk)
            written += len(chunk)
    if written == 0:
        os.remove(target)
        raise HTTPException(400, "上传内容为空")
    task_id = jobs.submit(str(target), name, _worker)
    return {"task_id": task_id, "file_name": name, "size": written}


@app.post("/api/demos/scan")
def scan_replays() -> dict:
    """扫描本机 Steam 常见位置里的 .dem（只登记，不解析）。"""
    import glob

    roots = [
        r"D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays",
        os.path.expandvars(r"%ProgramFiles(x86)%\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays"),
        os.path.expandvars(r"%ProgramFiles%\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays"),
    ]
    found: list[dict] = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for path in glob.glob(os.path.join(root, "*.dem")):
            try:
                found.append({"path": path, "name": os.path.basename(path), "size": os.path.getsize(path)})
            except OSError:
                continue
    found.sort(key=lambda f: f["size"], reverse=True)
    return {"roots_checked": roots, "found": found[:50], "total": len(found)}


@app.post("/api/demos/local")
def parse_local(path: str = Query(...)) -> dict:
    """解析本机已有路径的 demo（不复制文件）。"""
    if not os.path.isfile(path):
        raise HTTPException(400, f"文件不存在：{path}")
    if not path.lower().endswith(".dem"):
        raise HTTPException(400, "只接受 .dem 文件")
    task_id = jobs.submit(path, os.path.basename(path), _worker)
    return {"task_id": task_id, "file_name": os.path.basename(path)}


@app.get("/api/tasks")
def all_tasks() -> list[dict]:
    return jobs.list_tasks()


@app.get("/api/tasks/{task_id}")
def one_task(task_id: str) -> dict:
    task = jobs.get(task_id)
    if not task:
        raise HTTPException(404, "task not found")
    return task


# --------------------------------------------------------------------------- 静态前端

if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    page = STATIC_DIR / "index.html"
    if not page.exists():
        return JSONResponse({"detail": "前端未就绪"}, status_code=503)
    return FileResponse(str(page))


# --------------------------------------------------------------------------- 启动

def _pick_port(preferred: int) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 20)]:
        with socket.socket() as sock:
            try:
                sock.bind((HOST, port))
                return port
            except OSError:
                continue
    return preferred


def main() -> None:
    import uvicorn

    port = _pick_port(PORT)
    url = f"http://{HOST}:{port}"
    if os.environ.get("CS2_PANEL_NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"CS2 数据面板已启动：{url}", flush=True)
    uvicorn.run(app, host=HOST, port=port, log_level="info")


if __name__ == "__main__":
    main()
