"""单场比赛：列表、详情、记分板、回合、热力图、高光、回放、生命周期操作。"""
from __future__ import annotations

import json
import os
import shutil

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from .. import ingest, replay
from ..analysis import metrics
from ..analysis.common import RoundIndex, weapon_key
from ..services import stats
from .deps import LIFECYCLE_DEFAULT, Context, ctx, require_match

router = APIRouter(prefix="/api")


def _recycle_days(c: Context) -> int:
    return int(c.setting("lifecycle", LIFECYCLE_DEFAULT)["recycle_days"])


@router.get("/matches")
def list_matches(c: Context = Depends(ctx)) -> list[dict]:
    rows = c.store.list_matches()
    days = _recycle_days(c)
    sha_count: dict[str, int] = {}
    for m in rows:
        if m.get("demo_sha256"):
            sha_count[m["demo_sha256"]] = sha_count.get(m["demo_sha256"], 0) + 1
    for m in rows:
        m.update(stats.demo_status(m, days))
        m["duplicate"] = sha_count.get(m.get("demo_sha256") or "", 0) > 1
    return rows


@router.get("/matches/{match_id}")
def get_match(match_id: str, c: Context = Depends(ctx)) -> dict:
    match = require_match(c, match_id)
    match.pop("header", None)
    match.update(stats.demo_status(match, _recycle_days(c)))
    return {**match, "datasets": c.store.dataset_names(match_id),
            "score": {"terrorist": match["t_score"], "counter-terrorist": match["ct_score"]},
            "runs": c.store.runs(match_id)[:10]}


@router.patch("/matches/{match_id}")
def patch_match(match_id: str, body: dict = Body(...), c: Context = Depends(ctx)) -> dict:
    require_match(c, match_id)
    if "keep_demo" in body:
        c.store.update_match(match_id, keep_demo=bool(body["keep_demo"]))
    return {"id": match_id, "keep_demo": bool(c.store.get_match(match_id)["keep_demo"])}


def _managed_path(c: Context, match: dict) -> str | None:
    """只有程序自己保存在 数据/demos/ 下的文件才允许删除；Steam 目录里的原始录像绝不动。"""
    path = match.get("file_path")
    if not path or not match.get("demo_managed"):
        return None
    try:
        real, root = os.path.realpath(path), os.path.realpath(c.config.demo_dir)
    except OSError:
        return None
    return path if os.path.commonpath([real, root]) == root else None


@router.delete("/matches/{match_id}")
def delete_match(match_id: str, delete_demo: bool = True, c: Context = Depends(ctx)) -> dict:
    match = require_match(c, match_id)
    removed_demo = False
    path = _managed_path(c, match)
    if delete_demo and path and os.path.isfile(path):
        others = [m for m in c.store.list_matches() if m["id"] != match_id and m.get("file_path") == path]
        if not others:
            os.remove(path)
            removed_demo = True
    c.store.delete_match(match_id)
    shutil.rmtree(c.config.replay_cache / match_id, ignore_errors=True)
    return {"deleted": match_id, "demo_removed": removed_demo}


@router.delete("/matches/{match_id}/demo")
def delete_demo(match_id: str, c: Context = Depends(ctx)) -> dict:
    """回收 demo 本体：统计数据全部保留，只是之后无法生成新的回放、无法重解析。"""
    match = require_match(c, match_id)
    if match.get("keep_demo"):
        raise HTTPException(409, "这场标记了「保留回放」，先取消标记再回收")
    path = _managed_path(c, match)
    if not path:
        raise HTTPException(400, "demo 不在程序的数据目录里（例如直接从 Steam 目录解析的），不会删除原始文件")
    freed = 0
    if os.path.isfile(path):
        freed = os.path.getsize(path)
        os.remove(path)
    return {"id": match_id, "freed_bytes": freed}


@router.post("/matches/{match_id}/reparse")
def reparse(match_id: str, c: Context = Depends(ctx)) -> dict:
    match = require_match(c, match_id)
    if not match.get("file_path") or not os.path.isfile(match["file_path"]):
        raise HTTPException(410, "demo 本体已不在，无法重解析；可以重新导入同一个文件")
    shutil.rmtree(c.config.replay_cache / match_id, ignore_errors=True)
    task_id = c.jobs.submit("reparse", match["file_name"],
                            lambda report: ingest.reparse_match(c.store, match_id, parse_fn=c.parse_fn, report=report))
    return {"task_id": task_id}


@router.get("/matches/{match_id}/players")
def get_players(match_id: str, c: Context = Depends(ctx)) -> list[dict]:
    require_match(c, match_id)
    rows = stats.match_players(c.store, match_id)
    if not rows:
        raise HTTPException(404, "这场还没有派生数据（可能正在后台重算）")
    return rows


@router.get("/matches/{match_id}/rounds")
def get_rounds(match_id: str, c: Context = Depends(ctx)) -> dict:
    match = require_match(c, match_id)
    return {
        "rounds": c.store.get_dataset(match_id, "rounds"),
        "economy": c.store.get_dataset(match_id, "round_economy"),
        "timeline": c.store.query("SELECT * FROM rounds WHERE match_id = ? ORDER BY round_num", (match_id,)),
        "teams": {
            "A": {"score": match.get("team_a_score"), "name": match.get("team_a_name"),
                  "start_side": match.get("team_a_start_side")},
            "B": {"score": match.get("team_b_score"), "name": match.get("team_b_name")},
        },
    }


@router.get("/matches/{match_id}/highlights")
def get_highlights(match_id: str, c: Context = Depends(ctx)) -> list[dict]:
    require_match(c, match_id)
    rows = c.store.query("SELECT * FROM highlights WHERE match_id = ? ORDER BY score DESC", (match_id,))
    for row in rows:
        row["key_ticks"] = json.loads(row["key_ticks"] or "[]")
        row["evidence"] = json.loads(row["evidence"] or "{}")
    return rows


@router.get("/matches/{match_id}/heatmap")
def get_heatmap(
    match_id: str,
    type: str = Query("kills", pattern="^(kills|deaths|shots)$"),
    limit: int = Query(4000, ge=1, le=50000),
    round_num: int | None = Query(None, ge=1),
    side: str | None = Query(None, pattern="^(ct|t|counter-terrorist|terrorist)$"),
    weapon: str | None = None,
    steamid: str | None = None,
    c: Context = Depends(ctx),
) -> dict:
    """击杀/死亡/射击点集。回合按 official_end_tick 归属；阵营看行为人（kills/deaths 看 attacker_side）；
    武器两侧去掉 weapon_ 前缀后比较；steamid 只看某个玩家（kills/shots 看行为人，deaths 看受害者）。"""
    match = require_match(c, match_id)
    source = {"kills": "kills", "deaths": "kills", "shots": "shots"}[type]
    rows = c.store.get_dataset(match_id, source)
    total_before = len(rows)

    span = None
    if round_num is not None:
        span = RoundIndex(c.store.get_dataset(match_id, "rounds")).span(round_num)
        if span is None:
            raise HTTPException(404, f"没有第 {round_num} 回合")
    want_side = {"ct": "counter-terrorist", "t": "terrorist"}.get(side or "", side)
    want_weapon = weapon_key(weapon)
    sid_col = {"kills": "attacker_steamid", "deaths": "victim_steamid", "shots": "steamid"}[type]

    def keep(row: dict) -> bool:
        if span is not None:
            tick = row.get("tick")
            if tick is None or not span[0] <= tick <= span[1]:
                return False
        if want_side and (row.get("attacker_side") if type != "shots" else row.get("side")) != want_side:
            return False
        if want_weapon and weapon_key(row.get("weapon")) != want_weapon:
            return False
        if steamid and str(row.get(sid_col)) != steamid:
            return False
        return True

    filtered = [r for r in rows if keep(r)] if (span or want_side or want_weapon or steamid) else rows
    points = metrics.heatmap_points(filtered, type)
    if len(points) > limit:
        step = len(points) / limit
        points = [points[int(i * step)] for i in range(limit)]
    return {"map_name": match.get("map_name"), "type": type, "points": points, "total": total_before,
            "filtered": len(filtered), "filter": {"round_num": round_num, "side": side, "weapon": weapon, "steamid": steamid}}


@router.get("/matches/{match_id}/weapons")
def get_weapons(match_id: str, c: Context = Depends(ctx)) -> dict:
    """该场出现过的武器（已去 weapon_ 前缀并合并两侧口径），供筛选下拉用。"""
    require_match(c, match_id)
    kill_counts: dict[str, int] = {}
    shot_counts: dict[str, int] = {}
    for bucket, name in ((kill_counts, "kills"), (shot_counts, "shots")):
        for row in c.store.get_dataset(match_id, name):
            key = weapon_key(row.get("weapon"))
            if key:
                bucket[key] = bucket.get(key, 0) + 1
    names = sorted(set(kill_counts) | set(shot_counts), key=lambda n: -(kill_counts.get(n, 0) + shot_counts.get(n, 0)))
    return {"weapons": [{"name": n, "kills": kill_counts.get(n, 0), "shots": shot_counts.get(n, 0)} for n in names]}


@router.get("/matches/{match_id}/replay/{round_num}")
def get_replay(match_id: str, round_num: int, every: int = Query(replay.EVERY_DEFAULT), c: Context = Depends(ctx)) -> dict:
    """某回合的走位轨迹（落盘缓存）。demo 本体已回收时，只要缓存还在仍可播放。"""
    match = require_match(c, match_id)
    target = next((r for r in c.store.get_dataset(match_id, "rounds") if r.get("round_num") == round_num), None)
    if target is None:
        raise HTTPException(404, f"没有第 {round_num} 回合")
    try:
        data = replay.build(match.get("file_path") or "", target, every, c.config.replay_cache, match_id,
                            match.get("tick_rate"))
    except FileNotFoundError:
        raise HTTPException(410, "demo 本体已回收或不在原路径，这一回合也没有缓存的轨迹，无法生成回放。"
                                 "统计数据不受影响；如需回放请重新导入同一个 demo。")
    except Exception as exc:
        raise HTTPException(500, f"生成回放失败：{type(exc).__name__}: {exc}")
    data["map_name"] = match.get("map_name")
    data["round"] = target
    return data


@router.delete("/matches/{match_id}/replay")
def clear_replay_cache(match_id: str, c: Context = Depends(ctx)) -> dict:
    shutil.rmtree(c.config.replay_cache / match_id, ignore_errors=True)
    return {"cleared": match_id}


@router.get("/matches/{match_id}/dataset/{name}")
def get_dataset(match_id: str, name: str, c: Context = Depends(ctx)) -> JSONResponse:
    if name not in c.store.dataset_names(match_id):
        raise HTTPException(404, f"dataset {name} not found")
    return JSONResponse(c.store.get_dataset(match_id, name))


@router.get("/compare")
def compare_matches(ids: str = Query(..., description="逗号分隔的 match id，1-8 场"), c: Context = Depends(ctx)) -> dict:
    """多场对比：每场的元信息、队伍比分与玩家统计；前端按 steamid 跨场对齐。"""
    wanted = [x.strip() for x in ids.split(",") if x.strip()]
    if not wanted:
        raise HTTPException(400, "至少给一个 match id")
    if len(wanted) > 8:
        raise HTTPException(400, "一次最多对比 8 场")
    out = []
    for mid in wanted:
        match = require_match(c, mid)
        out.append({
            "id": mid, "file_name": match.get("file_name"), "map_name": match.get("map_name"),
            "ct_score": match.get("ct_score"), "t_score": match.get("t_score"),
            "team_a_score": match.get("team_a_score"), "team_b_score": match.get("team_b_score"),
            "round_count": match.get("round_count"), "created_at": match.get("created_at"),
            "played_at": match.get("played_at"),
            "economy": c.store.get_dataset(mid, "round_economy"),
            "rounds": c.store.query("SELECT round_num, winner_side, reason_name, score_a, score_b FROM rounds"
                                    " WHERE match_id = ? ORDER BY round_num", (mid,)),
            "players": stats.match_players(c.store, mid),
        })
    return {"matches": out}
