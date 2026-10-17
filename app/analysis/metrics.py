"""自算指标：HLTV Rating 近似、多杀计数、热力图点集。

awpy 3.0.0 已经提供 multikill_2k..5k 与 clutches，这里**独立重算多杀**用于交叉校验，
并补上 awpy 没有的 Rating 近似值（HLTV Rating 无官方公开定义，界面上必须标注"近似"）。
"""
from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from .common import RoundIndex, clean_sid, norm_side

MULTIKILL_EMPTY = {"2k": 0, "3k": 0, "4k": 0, "5k": 0, "ace": 0}


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
    """
    index = RoundIndex(rounds)
    per_round: dict[tuple[int, str], int] = defaultdict(int)
    for kill in kills:
        attacker = clean_sid(kill.get("attacker_steamid"))
        if not attacker:
            continue
        # 排除友军击杀：awpy 的 stats 也不计，否则多杀数会偏大
        # （M0 实测：Triangulation 因一个 teamkill 从 3 个 2K 被算成 4 个）。
        a_side, v_side = norm_side(kill.get("attacker_side")), norm_side(kill.get("victim_side"))
        if a_side and a_side == v_side:
            continue
        if attacker == clean_sid(kill.get("victim_steamid")):
            continue
        rnd = index.round_of(kill.get("tick"))
        if rnd is None:
            continue
        per_round[(rnd, attacker)] += 1

    result: dict[str, dict[str, int]] = defaultdict(lambda: dict(MULTIKILL_EMPTY))
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


def match_score(rounds: Iterable[dict]) -> dict[str, int]:
    """按回合胜者累计**阵营**比分（winner_side 为 'terrorist' / 'counter-terrorist'）。

    注意这不是队伍比分：半场换边后同一支队伍会在两个阵营下得分。队伍比分见 derive.py。
    """
    score = {"terrorist": 0, "counter-terrorist": 0}
    for r in rounds:
        side = norm_side(r.get("winner_side"))
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
