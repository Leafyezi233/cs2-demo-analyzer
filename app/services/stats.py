"""跨场聚合查询：全部在 SQL 里完成，前端拿到的就是最终数字。

统计范围（scope）= 某个账号最近 N 场（按比赛时间 played_at 倒序），可选只看某张地图。
所有比率类指标按回合加权；每行带 sample 字段，样本不足时界面必须提示「不下结论」。
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from ..analysis.common import CT, T
from ..analysis.derive import DERIVE_VERSION
from ..analysis.metrics import approximate_rating
from ..parser import PARSER_VERSION
from ..store import Store

MIN_GAMES = 3
MIN_ROUNDS = 30
MIN_SHOTS = 50

ORDER = "COALESCE(m.played_at, m.created_at)"


def sample_flag(games: int | None = None, rounds: int | None = None) -> str:
    if games is not None and games < MIN_GAMES:
        return "low"
    if rounds is not None and rounds < MIN_ROUNDS:
        return "low"
    return "ok"


def _scope(steamid: str, last: int = 0, map_name: str | None = None, offset: int = 0) -> tuple[str, list]:
    """返回 (CTE, 参数)：scope(match_id) = 该账号在范围内的场次。"""
    sql = ("WITH scope AS (SELECT pm.match_id FROM player_match pm JOIN matches m ON m.id = pm.match_id"
           " WHERE pm.steamid = ?")
    params: list[Any] = [steamid]
    if map_name:
        sql += " AND m.map_name = ?"
        params.append(map_name)
    sql += f" ORDER BY {ORDER} DESC LIMIT ? OFFSET ?) "
    params += [last if last and last > 0 else -1, offset]
    return sql, params


def roster(store: Store) -> list[dict]:
    rows = store.query(
        "SELECT pm.steamid, pm.name, pm.team_name, m.map_name, " + ORDER + " AS at FROM player_match pm"
        " JOIN matches m ON m.id = pm.match_id ORDER BY at DESC")
    out: dict[str, dict] = {}
    for row in rows:
        e = out.get(row["steamid"])
        if e is None:
            e = out[row["steamid"]] = {"steamid": row["steamid"], "name": row["name"], "team": row["team_name"] or "",
                                       "count": 0, "last_seen": row["at"], "maps": set()}
        e["count"] += 1
        e["maps"].add(row["map_name"])
    result = []
    for e in out.values():
        e["maps"] = sorted(m for m in e["maps"] if m)
        result.append(e)
    result.sort(key=lambda e: (-e["count"], str(e["name"])))
    return result


SUMMARY_SELECT = """
SELECT COUNT(*) AS games, COALESCE(SUM(pm.rounds_played),0) AS rounds,
  COALESCE(SUM(pm.kills),0) AS kills, COALESCE(SUM(pm.deaths),0) AS deaths, COALESCE(SUM(pm.assists),0) AS assists,
  COALESCE(SUM(pm.result='W'),0) AS w, COALESCE(SUM(pm.result='L'),0) AS l, COALESCE(SUM(pm.result='T'),0) AS t,
  SUM(pm.rating*pm.rounds_played)/NULLIF(SUM(CASE WHEN pm.rating IS NOT NULL THEN pm.rounds_played END),0) AS rating,
  SUM(pm.adr*pm.rounds_played)/NULLIF(SUM(pm.rounds_played),0) AS adr,
  SUM(pm.kast*pm.rounds_played)/NULLIF(SUM(pm.rounds_played),0) AS kast,
  COALESCE(SUM(pm.headshot_kills),0) AS headshot_kills, COALESCE(SUM(pm.opening_kills),0) AS opening_kills,
  COALESCE(SUM(pm.opening_deaths),0) AS opening_deaths, COALESCE(SUM(pm.clutches_played),0) AS clutches_played,
  COALESCE(SUM(pm.clutches_won),0) AS clutches_won, COALESCE(SUM(pm.utility_damage),0) AS utility_damage,
  COALESCE(SUM(pm.flash_assists),0) AS flash_assists, COALESCE(SUM(pm.traded_deaths),0) AS traded_deaths,
  COALESCE(SUM(pm.mk_3k),0) AS mk_3k, COALESCE(SUM(pm.mk_4k),0) AS mk_4k, COALESCE(SUM(pm.mk_5k),0) AS mk_5k,
  COALESCE(SUM(pm.rounds_won),0) AS rounds_won, MIN(""" + ORDER + """) AS first_at, MAX(""" + ORDER + """) AS last_at
FROM player_match pm JOIN matches m ON m.id = pm.match_id
WHERE pm.steamid = ? AND pm.match_id IN (SELECT match_id FROM scope)
"""


def _finish_summary(s: dict) -> dict:
    s["kd"] = round(s["kills"] / s["deaths"], 3) if s["deaths"] else float(s["kills"])
    s["win_rate"] = round(s["w"] / (s["w"] + s["l"]), 4) if (s["w"] + s["l"]) else None
    s["headshot_pct"] = round(100.0 * s["headshot_kills"] / s["kills"], 2) if s["kills"] else 0.0
    s["kpr"] = round(s["kills"] / s["rounds"], 3) if s["rounds"] else None
    s["dpr"] = round(s["deaths"] / s["rounds"], 3) if s["rounds"] else None
    s["round_win_pct"] = round(100.0 * s["rounds_won"] / s["rounds"], 2) if s["rounds"] else None
    for k in ("rating", "adr", "kast"):
        s[k] = round(s[k], 3) if s[k] is not None else None
    s["sample"] = sample_flag(s["games"], s["rounds"])
    return s


def summary(store: Store, steamid: str, last: int = 0, map_name: str | None = None) -> dict:
    cte, params = _scope(steamid, last, map_name)
    s = _finish_summary(store.query_one(cte + SUMMARY_SELECT, params + [steamid]))
    s["steamid"] = steamid
    s["sides"] = {row["side"]: row for row in side_rows(store, steamid, last, map_name)}
    if last and last > 0:  # 环比：紧接着的前 N 场
        cte, params = _scope(steamid, last, map_name, offset=last)
        prev = _finish_summary(store.query_one(cte + SUMMARY_SELECT, params + [steamid]))
        s["prev"] = prev if prev["games"] else None
    return s


def combine(summaries: list[dict]) -> dict:
    """多个账号合并成一组 KPI（计数相加，比率按回合加权）。"""
    keys = ("games", "rounds", "kills", "deaths", "assists", "w", "l", "t", "headshot_kills", "opening_kills",
            "opening_deaths", "clutches_played", "clutches_won", "utility_damage", "flash_assists", "traded_deaths",
            "mk_3k", "mk_4k", "mk_5k", "rounds_won")
    out: dict[str, Any] = {k: sum(s.get(k) or 0 for s in summaries) for k in keys}
    for k in ("rating", "adr", "kast"):
        weight = sum(s["rounds"] for s in summaries if s.get(k) is not None)
        out[k] = sum(s[k] * s["rounds"] for s in summaries if s.get(k) is not None) / weight if weight else None
    return _finish_summary(out)


def timeline(store: Store, steamid: str, last: int = 0, map_name: str | None = None) -> list[dict]:
    cte, params = _scope(steamid, last, map_name)
    return store.query(
        cte + "SELECT m.id AS match_id, m.map_name, m.file_name, " + ORDER + " AS played_at, m.round_count,"
        " pm.team_score, pm.opp_score, pm.result, pm.start_side, pm.rating, pm.adr, pm.kast, pm.kills, pm.deaths,"
        " pm.assists, pm.headshot_pct, pm.opening_kills, pm.opening_deaths, pm.utility_damage, pm.rounds_played,"
        " pm.clutches_won, pm.mk_3k, pm.mk_4k, pm.mk_5k, pm.name"
        " FROM player_match pm JOIN matches m ON m.id = pm.match_id"
        " WHERE pm.steamid = ? AND pm.match_id IN (SELECT match_id FROM scope) ORDER BY " + ORDER + " ASC",
        params + [steamid])


ROUND_AGG = """
COUNT(*) AS rounds, SUM(pr.kills) AS kills, SUM(pr.deaths) AS deaths, SUM(pr.assists) AS assists,
SUM(pr.damage) AS damage, SUM(pr.kast) AS kast_rounds, SUM(pr.won) AS won, SUM(pr.opening_kill) AS opening_kills,
SUM(pr.opening_death) AS opening_deaths, SUM(pr.headshots) AS headshots, SUM(pr.clutch_vs > 0) AS clutches,
SUM(pr.clutch_won) AS clutches_won, SUM(pr.util_damage) AS util_damage, COUNT(DISTINCT pr.match_id) AS games
"""


def _finish_round_row(row: dict) -> dict:
    n = row["rounds"] or 0
    row["adr"] = round(row["damage"] / n, 2) if n else None
    row["kast"] = round(100.0 * row["kast_rounds"] / n, 2) if n else None
    row["round_win_pct"] = round(100.0 * row["won"] / n, 2) if n else None
    row["kd"] = round(row["kills"] / row["deaths"], 3) if row["deaths"] else float(row["kills"] or 0)
    row["headshot_pct"] = round(100.0 * row["headshots"] / row["kills"], 2) if row["kills"] else 0.0
    row["opening_success"] = (round(100.0 * row["opening_kills"] / (row["opening_kills"] + row["opening_deaths"]), 2)
                              if (row["opening_kills"] + row["opening_deaths"]) else None)
    row["rating"] = approximate_rating({"rounds_played": n, "kills": row["kills"], "deaths": row["deaths"],
                                        "assists": row["assists"], "kast": row["kast"] or 0, "adr": row["adr"] or 0})
    row["sample"] = sample_flag(rounds=n)
    return row


def side_rows(store: Store, steamid: str, last: int = 0, map_name: str | None = None) -> list[dict]:
    cte, params = _scope(steamid, last, map_name)
    rows = store.query(cte + "SELECT pr.side, " + ROUND_AGG + " FROM player_round pr WHERE pr.steamid = ?"
                       " AND pr.match_id IN (SELECT match_id FROM scope) AND pr.side IN (?, ?) GROUP BY pr.side",
                       params + [steamid, CT, T])
    return [_finish_round_row(r) for r in rows]


def breakdown(store: Store, steamid: str, dim: str, last: int = 0, map_name: str | None = None) -> list[dict]:
    cte, params = _scope(steamid, last, map_name)
    if dim == "side":
        return side_rows(store, steamid, last, map_name)
    if dim == "map":
        rows = store.query(
            cte + "SELECT m.map_name AS map_name, COUNT(*) AS games, SUM(pm.rounds_played) AS rounds,"
            " SUM(pm.result='W') AS w, SUM(pm.result='L') AS l, SUM(pm.result='T') AS t, SUM(pm.kills) AS kills,"
            " SUM(pm.deaths) AS deaths, SUM(pm.assists) AS assists,"
            " SUM(pm.rating*pm.rounds_played)/NULLIF(SUM(pm.rounds_played),0) AS rating,"
            " SUM(pm.adr*pm.rounds_played)/NULLIF(SUM(pm.rounds_played),0) AS adr,"
            " SUM(pm.kast*pm.rounds_played)/NULLIF(SUM(pm.rounds_played),0) AS kast"
            " FROM player_match pm JOIN matches m ON m.id = pm.match_id WHERE pm.steamid = ?"
            " AND pm.match_id IN (SELECT match_id FROM scope) GROUP BY m.map_name ORDER BY games DESC, rounds DESC",
            params + [steamid])
        for r in rows:
            r["kd"] = round(r["kills"] / r["deaths"], 3) if r["deaths"] else float(r["kills"])
            r["win_rate"] = round(r["w"] / (r["w"] + r["l"]), 4) if (r["w"] + r["l"]) else None
            for k in ("rating", "adr", "kast"):
                r[k] = round(r[k], 3) if r[k] is not None else None
            r["sample"] = sample_flag(r["games"], r["rounds"])
        return rows
    if dim == "map_side":
        rows = store.query(
            cte + "SELECT m.map_name AS map_name, pr.side, " + ROUND_AGG + " FROM player_round pr"
            " JOIN matches m ON m.id = pr.match_id WHERE pr.steamid = ? AND pr.match_id IN (SELECT match_id FROM scope)"
            " AND pr.side IN (?, ?) GROUP BY m.map_name, pr.side ORDER BY m.map_name, pr.side",
            params + [steamid, CT, T])
        return [_finish_round_row(r) for r in rows]
    if dim == "weapon":
        rows = store.query(
            cte + "SELECT pw.weapon, SUM(pw.shots) AS shots, SUM(pw.hits) AS hits, SUM(pw.damage) AS damage,"
            " SUM(pw.kills) AS kills, SUM(pw.headshots) AS headshots, COUNT(DISTINCT pw.match_id) AS games"
            " FROM player_weapon pw WHERE pw.steamid = ? AND pw.match_id IN (SELECT match_id FROM scope)"
            " GROUP BY pw.weapon ORDER BY kills DESC, damage DESC", params + [steamid])
        for r in rows:
            r["accuracy"] = round(100.0 * r["hits"] / r["shots"], 2) if r["shots"] else None
            r["headshot_pct"] = round(100.0 * r["headshots"] / r["kills"], 2) if r["kills"] else 0.0
            r["shots_per_kill"] = round(r["shots"] / r["kills"], 2) if r["kills"] and r["shots"] else None
            r["sample"] = "low" if (r["shots"] or 0) < MIN_SHOTS and (r["kills"] or 0) < 10 else "ok"
        return rows
    if dim == "economy":
        rows = store.query(
            cte + "SELECT CASE WHEN pr.side = ? THEN r.ct_buy ELSE r.t_buy END AS buy_type, " + ROUND_AGG +
            " FROM player_round pr JOIN rounds r ON r.match_id = pr.match_id AND r.round_num = pr.round_num"
            " WHERE pr.steamid = ? AND pr.match_id IN (SELECT match_id FROM scope) GROUP BY buy_type",
            params + [CT, steamid])
        order = {"pistol": 0, "eco": 1, "force": 2, "full": 3}
        rows.sort(key=lambda r: order.get(r["buy_type"], 9))
        return [_finish_round_row(r) for r in rows]
    raise ValueError(f"未知维度：{dim}")


def match_players(store: Store, match_id: str) -> list[dict]:
    rows = store.query("SELECT * FROM player_match WHERE match_id = ? ORDER BY rating DESC", (match_id,))
    sides = store.query("SELECT pr.steamid, pr.side, " + ROUND_AGG + " FROM player_round pr WHERE pr.match_id = ?"
                        " GROUP BY pr.steamid, pr.side", (match_id,))
    by_player: dict[str, dict] = {}
    for s in sides:
        by_player.setdefault(s["steamid"], {})["ct" if s["side"] == CT else "t"] = _finish_round_row(s)
    for row in rows:
        row["split"] = by_player.get(row["steamid"], {})
        row["side"] = row["last_side"]                      # 兼容旧前端字段
        row["team_clan_name"] = row["team_name"]
        row["multikill_calc"] = {"2k": row["mk_2k"], "3k": row["mk_3k"], "4k": row["mk_4k"], "5k": row["mk_5k"],
                                 "ace": row["mk_5k"]}
    return rows


# --------------------------------------------------------------------------- 库健康度

def _dir_size(path: Path) -> int:
    total = 0
    if path.is_dir():
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    return total


def demo_status(match: dict, recycle_days: int, now: float | None = None) -> dict:
    """单场 demo 本体的状态：present / missing，是否可回收（受管 + 未标记保留 + 超过天数）。"""
    now = now or time.time()
    path = match.get("file_path")
    present = bool(path and os.path.isfile(path))
    age_days = (now - (match.get("created_at") or now)) / 86400
    recyclable = present and bool(match.get("demo_managed")) and not match.get("keep_demo") and age_days >= recycle_days
    return {"demo_present": present, "recyclable": recyclable, "age_days": round(age_days, 1)}


def overview(store: Store, data_dir: Path, recycle_days: int) -> dict:
    matches = store.list_matches()
    present = [m for m in matches if m.get("file_path") and os.path.isfile(m["file_path"])]
    managed_size = sum(os.path.getsize(m["file_path"]) for m in present if m.get("demo_managed"))
    dups = store.query("SELECT demo_sha256, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM matches"
                       " WHERE demo_sha256 IS NOT NULL GROUP BY demo_sha256 HAVING n > 1")
    failures = store.query("SELECT at, file_name, error FROM import_log WHERE status = 'failed' ORDER BY id DESC LIMIT 20")
    db_files = [data_dir / n for n in ("panel.db", "panel.db-wal", "panel.db-shm")]
    return {
        "matches": len(matches),
        "players": store.query_one("SELECT COUNT(DISTINCT steamid) AS n FROM player_match")["n"],
        "rounds": sum(m.get("round_count") or 0 for m in matches),
        "maps": sorted({m["map_name"] for m in matches if m.get("map_name")}),
        "demos_present": len(present),
        "demos_missing": len(matches) - len(present),
        "recyclable": sum(1 for m in matches if demo_status(m, recycle_days)["recyclable"]),
        "kept": sum(1 for m in matches if m.get("keep_demo")),
        "stale_derive": sum(1 for m in matches if (m.get("derive_version") or 0) < DERIVE_VERSION),
        "reparse_candidates": sum(1 for m in present if (m.get("parser_version") or 0) < PARSER_VERSION),
        "duplicates": [{"sha256": d["demo_sha256"], "ids": d["ids"].split(",")} for d in dups],
        "import_failures": failures,
        "storage": {
            "db_bytes": sum(p.stat().st_size for p in db_files if p.exists()),
            "demos_bytes": managed_size,
            "external_demos": sum(1 for m in present if not m.get("demo_managed")),
            "replay_cache_bytes": _dir_size(data_dir / "replay_cache"),
            "backups_bytes": _dir_size(data_dir / "backups"),
        },
        "versions": {"parser": PARSER_VERSION, "derive": DERIVE_VERSION},
        "recycle_days": recycle_days,
    }
