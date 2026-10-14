"""自算指标：HLTV Rating 近似 与 多杀计数。

awpy 3.0.0 已经提供 multikill_2k..5k 与 clutches，这里**独立重算多杀**用于交叉校验，
并补上 awpy 没有的 Rating 近似值（HLTV Rating 无官方公开定义，界面上必须标注"近似"）。
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Iterable


def approximate_rating(stat: dict) -> float | None:
    """社区通行的 Rating 2.0 近似式（非官方定义，仅作横向比较）。

    Rating ≈ 0.0073*KAST + 0.3591*KPR - 0.5329*DPR + 0.2372*Impact + 0.0032*ADR + 0.1587
    Impact = 2.13*KPR + 0.42*APR - 0.41
    KAST 需为百分数（0-100）。

    注意：awpy 的 kast 列实测为百分数（如 61.9），不是 0-1 小数。
    """
    rounds = stat.get("rounds_played") or 0
    if rounds <= 0:
        return None
    kpr = (stat.get("kills") or 0) / rounds
    dpr = (stat.get("deaths") or 0) / rounds
    apr = (stat.get("assists") or 0) / rounds
    kast = stat.get("kast") or 0.0
    adr = stat.get("adr") or 0.0
    impact = 2.13 * kpr + 0.42 * apr - 0.41
    rating = 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587
    return round(rating, 3)


def multikills(kills: Iterable[dict], rounds: Iterable[dict]) -> dict[str, dict[str, int]]:
    """按 (回合, 击杀者) 统计单回合击杀数，得到 2K/3K/4K/5K。

    返回 {steamid: {"2k": n, "3k": n, "4k": n, "5k": n, "ace": n}}。
    以 rounds 的 start_tick/end_tick 把击杀归属到回合（比依赖事件更稳）。
    """
    # 用 official_end_tick 而不是 end_tick：end_tick 是最后一击的时刻，
    # 其后到 official_end_tick 之间仍可能发生击杀（M0 实测：end_tick 会漏掉 4 个击杀，
    # official_end_tick 只漏 3 个）。
    spans = sorted(
        ((r["start_tick"], r.get("official_end_tick") or r["end_tick"], r["round_num"])
         for r in rounds if r.get("official_end_tick") or r.get("end_tick")),
        key=lambda x: x[0],
    )

    def round_of(tick: int) -> int | None:
        lo, hi = 0, len(spans) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            start, end, num = spans[mid]
            if tick < start:
                hi = mid - 1
            elif tick > end:
                lo = mid + 1
            else:
                return num
        return None

    per_round: dict[tuple[int, str], int] = defaultdict(int)
    for kill in kills:
        attacker = kill.get("attacker_steamid")
        if not attacker:
            continue
        # 排除友军击杀：awpy 的 stats 也不计，否则多杀数会偏大
        # （M0 实测：Triangulation 因一个 teamkill 从 3 个 2K 被算成 4 个）。
        if kill.get("attacker_side") and kill.get("attacker_side") == kill.get("victim_side"):
            continue
        rnd = round_of(kill["tick"])
        if rnd is None:
            continue
        per_round[(rnd, attacker)] += 1

    result: dict[str, dict[str, int]] = defaultdict(lambda: {"2k": 0, "3k": 0, "4k": 0, "5k": 0, "ace": 0})
    for (_rnd, steamid), count in per_round.items():
        bucket = result[steamid]
        if count == 2:
            bucket["2k"] += 1
        elif count == 3:
            bucket["3k"] += 1
        elif count == 4:
            bucket["4k"] += 1
        elif count >= 5:
            bucket["5k"] += 1
            bucket["ace"] += 1
    return dict(result)


def opening_duels(kills: Iterable[dict], rounds: Iterable[dict]) -> dict[str, dict[str, int]]:
    """每回合第一个击杀 = 首杀/首死（awpy 的 stats 里也有，这里独立重算）。"""
    first: dict[int, dict] = {}
    for kill in sorted(kills, key=lambda k: k["tick"]):
        rnd = None
        for r in rounds:
            if r.get("start_tick") is not None and r["start_tick"] <= kill["tick"] <= (r.get("end_tick") or 0):
                rnd = r["round_num"]
                break
        if rnd is None:
            continue
        first.setdefault(rnd, kill)

    out: dict[str, dict[str, int]] = defaultdict(lambda: {"opening_kills": 0, "opening_deaths": 0})
    for kill in first.values():
        atk, vic = kill.get("attacker_steamid"), kill.get("victim_steamid")
        if atk:
            out[atk]["opening_kills"] += 1
        if vic:
            out[vic]["opening_deaths"] += 1
    return dict(out)


def match_score(rounds: Iterable[dict]) -> dict[str, int]:
    """按回合胜者累计比分（winner_side 为 'terrorist' / 'counter-terrorist'）。"""
    score = {"terrorist": 0, "counter-terrorist": 0}
    for r in rounds:
        side = r.get("winner_side")
        if side in score:
            score[side] += 1
    return score


def heatmap_points(rows: Iterable[dict], kind: str) -> list[dict]:
    """把击杀/死亡/射击记录压成 {x, y, z, w} 点集，供前端叠在雷达图上。"""
    points: list[dict] = []
    for row in rows:
        if kind == "kills":
            x, y, z = row.get("attacker_x"), row.get("attacker_y"), row.get("attacker_z")
            extra = {"weapon": row.get("weapon"), "headshot": row.get("headshot"), "tick": row.get("tick")}
        elif kind == "deaths":
            x, y, z = row.get("victim_x"), row.get("victim_y"), row.get("victim_z")
            extra = {"weapon": row.get("weapon"), "tick": row.get("tick")}
        else:  # shots
            x, y, z = row.get("x"), row.get("y"), row.get("z")
            extra = {"weapon": row.get("weapon"), "tick": row.get("tick")}
        if x is None or y is None:
            continue
        points.append({"x": x, "y": y, "z": z or 0.0, "w": 1.0, **extra})
    return points
