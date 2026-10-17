"""数据驱动的高光识别（不依赖录像工具）。

输入是 derive.py 产出的击杀明细与每人每回合事实，输出结构化高光事件：
    {round_num, steamid, kind, tick_start, tick_end, score, title, evidence}

窗口 = [第一个击杀前 3 秒, 最后一个击杀后 2 秒]，可直接喂给回放页跳转，
将来如果接入录像/剪辑工具，也可以按 tick / tick_rate 换算成秒去裁片段。
评分是可解释的加权和，满分 1.0，只用于排序，不代表任何官方口径。
"""
from __future__ import annotations

from collections import defaultdict

from .derive import Derived

PRE_SECONDS = 3.0
POST_SECONDS = 2.0
FAST_WINDOW_SECONDS = 4.0

BASE_SCORE = {"ace": 0.80, "4k": 0.62, "clutch": 0.55, "3k": 0.42, "fast_multi": 0.40, "special": 0.25}


def detect(derived: Derived, tick_rate: float | None) -> list[dict]:
    rate = tick_rate or 64.0
    kills_by = defaultdict(list)
    for k in derived.kills:
        if k["attacker_steamid"] and k["attacker_side"] and k["victim_side"] and k["attacker_side"] != k["victim_side"]:
            kills_by[(k["round_num"], k["attacker_steamid"])].append(k)
    pr = {(r["round_num"], r["steamid"]): r for r in derived.player_round}
    names = {p["steamid"]: p["name"] for p in derived.player_match}

    out: list[dict] = []
    for (rnd, sid), kills in kills_by.items():
        kills.sort(key=lambda k: k["tick"] or 0)
        n = len(kills)
        facts = pr.get((rnd, sid)) or {}
        hs = sum(k["headshot"] for k in kills)
        specials = [k for k in kills if k["noscope"] or k["thrusmoke"] or k["penetrated"] or k["attackerblind"]]
        evidence = {
            "kills": n, "headshots": hs, "weapons": sorted({k["weapon"] for k in kills if k["weapon"]}),
            "noscope": sum(k["noscope"] for k in kills), "thrusmoke": sum(k["thrusmoke"] for k in kills),
            "wallbang": sum(k["penetrated"] for k in kills), "blind": sum(k["attackerblind"] for k in kills),
            "round_won": bool(facts.get("won")),
        }

        kind = None
        if n >= 5:
            kind = "ace"
        elif n == 4:
            kind = "4k"
        elif n == 3:
            kind = "3k"
        clutch_vs = facts.get("clutch_vs") or 0
        clutch_won = bool(facts.get("clutch_won"))
        if clutch_won and clutch_vs >= 2 and (kind is None or BASE_SCORE["clutch"] + 0.08 * clutch_vs > BASE_SCORE[kind]):
            kind = "clutch"
        span = (kills[-1]["tick"] - kills[0]["tick"]) / rate if n >= 2 else None
        if kind is None and n >= 2 and span is not None and span <= FAST_WINDOW_SECONDS:
            kind = "fast_multi"
        if kind is None and specials:
            kind = "special"
        if kind is None:
            continue

        score = BASE_SCORE[kind]
        if kind == "clutch":
            score += 0.08 * clutch_vs
        score += 0.04 * hs / max(1, n)
        score += 0.05 * min(len(specials), 3)
        if span is not None and n >= 3 and span <= FAST_WINDOW_SECONDS:
            score += 0.06
        if evidence["round_won"]:
            score += 0.04
        if clutch_won and kind != "clutch" and clutch_vs:
            score += 0.03 * clutch_vs

        evidence.update({"clutch_vs": clutch_vs, "clutch_won": clutch_won,
                         "span_seconds": round(span, 2) if span is not None else None})
        out.append({
            "round_num": rnd,
            "steamid": sid,
            "name": names.get(sid, sid),
            "kind": kind,
            "tick_start": int(kills[0]["tick"] - PRE_SECONDS * rate),
            "tick_end": int(kills[-1]["tick"] + POST_SECONDS * rate),
            "key_ticks": [k["tick"] for k in kills],
            "score": round(min(score, 1.0), 3),
            "title": _title(kind, n, clutch_vs, specials),
            "evidence": evidence,
        })
    out.sort(key=lambda h: (-h["score"], h["round_num"]))
    return out


def _title(kind: str, n: int, clutch_vs: int, specials: list[dict]) -> str:
    if kind == "ace":
        return "五杀 ACE"
    if kind == "clutch":
        return f"1v{clutch_vs} 残局" + (f"（{n} 杀）" if n else "")
    if kind in ("4k", "3k"):
        return f"{n} 杀回合"
    if kind == "fast_multi":
        return f"{n} 连杀（{FAST_WINDOW_SECONDS:.0f} 秒内）"
    tags = []
    if any(k["noscope"] for k in specials):
        tags.append("盲狙")
    if any(k["thrusmoke"] for k in specials):
        tags.append("穿烟")
    if any(k["penetrated"] for k in specials):
        tags.append("穿墙")
    if any(k["attackerblind"] for k in specials):
        tags.append("被闪击杀")
    return "·".join(tags) + "击杀"
