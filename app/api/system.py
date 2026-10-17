"""系统：健康检查、库概览、设置、维护任务、导出、地图资产。"""
from __future__ import annotations

import os
import struct
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .. import __version__, ingest, parser
from ..analysis import narrate
from ..analysis.derive import DERIVE_VERSION
from ..config import LOCAL_MAPDATA
from ..services import stats
from ..store import SCHEMA_VERSION
from .deps import LIFECYCLE_DEFAULT, Context, ctx

router = APIRouter(prefix="/api")


@router.get("/health")
def health(c: Context = Depends(ctx)) -> dict:
    return {
        "ok": True, "version": __version__, "schema_version": SCHEMA_VERSION,
        "parser_version": parser.PARSER_VERSION, "derive_version": DERIVE_VERSION,
        "awpy_version": parser.awpy_version(),
        "mapdata": str(LOCAL_MAPDATA) if LOCAL_MAPDATA.is_dir() else None,
        "migration_note": c.store.migration_note,
    }


@router.get("/stats/overview")
def overview(c: Context = Depends(ctx)) -> dict:
    days = int(c.setting("lifecycle", LIFECYCLE_DEFAULT)["recycle_days"])
    data = stats.overview(c.store, c.config.data_dir, days)
    data["jobs"] = [t for t in c.jobs.list() if t["status"] in ("queued", "running")]
    return data


@router.get("/settings")
def get_settings(c: Context = Depends(ctx)) -> dict:
    return {"lifecycle": c.setting("lifecycle", LIFECYCLE_DEFAULT),
            "ai": narrate.public_config(c.store.get_setting("ai", {})),
            "ai_providers": list(narrate.PROVIDERS), "ai_default_models": narrate.DEFAULT_MODELS}


@router.put("/settings/lifecycle")
def put_lifecycle(body: dict = Body(...), c: Context = Depends(ctx)) -> dict:
    cur = c.setting("lifecycle", LIFECYCLE_DEFAULT)
    if "recycle_days" in body:
        cur["recycle_days"] = max(1, min(3650, int(body["recycle_days"])))
    if "scan_dirs" in body:
        dirs = body["scan_dirs"]
        if isinstance(dirs, str):
            dirs = [d.strip() for d in dirs.splitlines()]
        cur["scan_dirs"] = [str(d) for d in dirs if str(d).strip()][:20]
    c.store.set_setting("lifecycle", cur)
    return cur


@router.put("/settings/ai")
def put_ai(body: dict = Body(...), c: Context = Depends(ctx)) -> dict:
    try:
        cfg = narrate.merge_config(c.store.get_setting("ai", {}), body)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc))
    c.store.set_setting("ai", cfg)
    return narrate.public_config(cfg)


@router.post("/maintenance/rederive")
def rederive(body: dict = Body(default={}), c: Context = Depends(ctx)) -> dict:
    """用存档的原始数据重算派生层。all=true 时全部重算，否则只算口径过期的场次。"""
    running = c.jobs.active("rederive")
    if running:
        return {"task_id": running[0]["id"], "already_running": True}
    ids = [m["id"] for m in c.store.list_matches()] if body.get("all") else None
    task_id = c.jobs.submit("rederive", "重算派生数据", lambda report: ingest.rederive(c.store, ids, report))
    return {"task_id": task_id, "already_running": False}


@router.post("/maintenance/recycle")
def recycle(body: dict = Body(default={}), c: Context = Depends(ctx)) -> dict:
    """批量回收可回收的 demo 本体（受管 + 未标记保留 + 超过天数）。必须显式传 confirm=true。"""
    if not body.get("confirm"):
        raise HTTPException(400, "需要 confirm=true")
    from .matches import _managed_path
    days = int(c.setting("lifecycle", LIFECYCLE_DEFAULT)["recycle_days"])
    freed, count = 0, 0
    for m in c.store.list_matches():
        if not stats.demo_status(m, days)["recyclable"]:
            continue
        path = _managed_path(c, m)
        if path and os.path.isfile(path):
            freed += os.path.getsize(path)
            os.remove(path)
            count += 1
    return {"recycled": count, "freed_bytes": freed}


@router.post("/maintenance/backup")
def backup(c: Context = Depends(ctx)) -> dict:
    path = c.store.backup(tag="manual")
    return {"path": path, "bytes": os.path.getsize(path)}


@router.get("/export/db")
def export_db(c: Context = Depends(ctx)):
    """导出数据库快照（换机 / 长期保存的兜底：真正的资产是这份库，不是 demo）。"""
    c.config.backup_dir.mkdir(parents=True, exist_ok=True)
    path = c.config.backup_dir / f"export-{time.strftime('%Y%m%d-%H%M%S')}.db"
    c.store.backup(path)
    return FileResponse(str(path), media_type="application/octet-stream",
                        filename=f"cs2-panel-{time.strftime('%Y%m%d')}.db",
                        background=BackgroundTask(lambda: path.unlink(missing_ok=True)))


@router.get("/maps/{map_name}/info")
def map_info(map_name: str) -> dict:
    """雷达图变换参数（世界坐标 -> 像素）与底图可用性。"""
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
    radar_ok, radar_size = False, None
    try:
        radar = Path(ad.radar_path(map_name))
        radar_ok = radar.is_file()
        if radar_ok:  # 雷达 PNG 实测 1024x1024（awpy-data 2000930 的 images.zip），这里仍按文件头读真实尺寸
            with open(radar, "rb") as fh:
                head = fh.read(24)
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                radar_size = list(struct.unpack(">II", head[16:24]))
    except Exception:
        radar_ok = False
    # 与 awpy.plot.world_to_pixel 一致的换算：(x - pos_x)/scale, (pos_y - y)/scale
    return {
        "map_name": map_name, "scale": data.get("scale"),
        "offset_x": data.get("pos_x", data.get("offset_x")), "offset_y": data.get("pos_y", data.get("offset_y")),
        "radar": radar_ok, "radar_size": radar_size, "raw_keys": sorted(data.keys()),
    }


@router.get("/maps/{map_name}/radar.png")
def map_radar(map_name: str):
    try:
        import awpy.data as ad
        path = Path(ad.radar_path(map_name))
    except Exception as exc:
        raise HTTPException(404, f"雷达底图缺失（{map_name}）：{exc}")
    if not path.is_file():
        raise HTTPException(404, "radar image not found")
    return FileResponse(str(path), media_type="image/png")
