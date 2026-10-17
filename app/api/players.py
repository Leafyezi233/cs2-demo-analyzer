"""跨场：名册、账号汇总、趋势、维度拆分、高光、规则发现与 AI 复盘。"""
from __future__ import annotations

import json
import time

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from ..analysis import insights, narrate
from ..services import stats
from .deps import Context, ctx

router = APIRouter(prefix="/api")
DIMS = "^(side|map|map_side|weapon|economy)$"


@router.get("/roster")
def roster(c: Context = Depends(ctx)) -> list[dict]:
    """库里出现过的全部玩家（按出场次数排序），设置页挑选「我的账号」用。"""
    return stats.roster(c.store)


@router.get("/players/summary")
def players_summary(steamids: str = Query(..., description="逗号分隔"), last: int = Query(0, ge=0),
                    map_name: str | None = Query(None, alias="map"), c: Context = Depends(ctx)) -> dict:
    ids = [s.strip() for s in steamids.split(",") if s.strip()][:20]
    if not ids:
        raise HTTPException(400, "至少给一个 steamid")
    accounts = [stats.summary(c.store, sid, last, map_name) for sid in ids]
    present = [a for a in accounts if a["games"]]
    return {"accounts": accounts, "combined": stats.combine(present) if present else None,
            "thresholds": {"min_games": stats.MIN_GAMES, "min_rounds": stats.MIN_ROUNDS}}


@router.get("/players/{steamid}/timeline")
def player_timeline(steamid: str, last: int = Query(0, ge=0), map_name: str | None = Query(None, alias="map"),
                    c: Context = Depends(ctx)) -> list[dict]:
    return stats.timeline(c.store, steamid, last, map_name)


@router.get("/players/{steamid}/breakdown")
def player_breakdown(steamid: str, dim: str = Query("side", pattern=DIMS), last: int = Query(0, ge=0),
                     map_name: str | None = Query(None, alias="map"), c: Context = Depends(ctx)) -> dict:
    return {"dim": dim, "rows": stats.breakdown(c.store, steamid, dim, last, map_name)}


@router.get("/players/{steamid}/highlights")
def player_highlights(steamid: str, limit: int = Query(20, ge=1, le=200), last: int = Query(0, ge=0),
                      map_name: str | None = Query(None, alias="map"), c: Context = Depends(ctx)) -> list[dict]:
    cte, params = stats._scope(steamid, last, map_name)
    rows = c.store.query(
        cte + "SELECT h.*, m.map_name, m.file_name, COALESCE(m.played_at, m.created_at) AS played_at,"
        " m.tick_rate FROM highlights h JOIN matches m ON m.id = h.match_id"
        " WHERE h.steamid = ? AND h.match_id IN (SELECT match_id FROM scope) ORDER BY h.score DESC LIMIT ?",
        params + [steamid, limit])
    for row in rows:
        row["key_ticks"] = json.loads(row["key_ticks"] or "[]")
        row["evidence"] = json.loads(row["evidence"] or "{}")
    return rows


@router.get("/players/{steamid}/insights")
def player_insights(steamid: str, last: int = Query(0, ge=0), map_name: str | None = Query(None, alias="map"),
                    c: Context = Depends(ctx)) -> dict:
    return insights.build(c.store, steamid, last, map_name)


@router.post("/players/{steamid}/report")
def player_report(steamid: str, body: dict = Body(default={}), c: Context = Depends(ctx)) -> dict:
    """生成一份复盘：规则发现（数字）+ AI 叙述（文字）。结果落库，带引擎/提示词版本与模型名。"""
    last = int(body.get("last") or 0)
    report = insights.build(c.store, steamid, last, body.get("map") or None)
    name = next((r["name"] for r in stats.roster(c.store) if r["steamid"] == steamid), None)
    cfg = c.store.get_setting("ai", {}) or {}
    if body.get("provider"):
        cfg = {**cfg, "provider": body["provider"]}
    error, result = None, None
    try:
        result = narrate.narrate(report, cfg, name)
    except narrate.NarrateError as exc:
        error = str(exc)
    narrative = result["narrative"] if result else None
    with c.store.write() as conn:
        cur = conn.execute(
            "INSERT INTO reports (steamid, created_at, engine_version, prompt_version, provider, model, scope,"
            " findings, narrative, error) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (steamid, time.time(), report["engine_version"], narrate.PROMPT_VERSION,
             (result or {}).get("provider") or cfg.get("provider"), (result or {}).get("model"),
             json.dumps(report["scope"]), json.dumps(report, ensure_ascii=False, default=str), narrative, error))
        report_id = cur.lastrowid
    return {"id": report_id, "report": report, "narrative": narrative, "error": error,
            "fallback": narrate.offline_narrative(report) if error else None,
            "provider": (result or {}).get("provider") or cfg.get("provider", "none"),
            "model": (result or {}).get("model"),
            "prompt": (result or {}).get("prompt") or narrate.build_prompt(report, name),
            "system_prompt": narrate.SYSTEM_PROMPT}


@router.get("/players/{steamid}/reports")
def player_reports(steamid: str, limit: int = Query(5, ge=1, le=50), c: Context = Depends(ctx)) -> list[dict]:
    rows = c.store.query("SELECT id, created_at, engine_version, prompt_version, provider, model, scope, narrative,"
                         " error FROM reports WHERE steamid = ? ORDER BY id DESC LIMIT ?", (steamid, limit))
    for row in rows:
        row["scope"] = json.loads(row["scope"] or "{}")
    return rows
