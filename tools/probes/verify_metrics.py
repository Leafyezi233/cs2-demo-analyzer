r"""交叉校验：自算多杀 / 首杀首死 与 awpy 的 stats 是否一致。

M0 时用它对同一份 demo 复验过 0 mismatch（见 markdown/cs2-demo-analyzer/开发记录-2026-10-14.md）。
PR #1 把 app/metrics.py 移到 app/analysis/metrics.py 并删掉了 opening_duels，本脚本随之失效；
现在改为直接调用 app.analysis.metrics，并在本地重算首杀（口径与 app/analysis/derive.py 一致：
用 official_end_tick 归回合）。

用法：
    .venv\Scripts\python.exe tools\probes\verify_metrics.py
    CS2_DEMO=<其他 demo 路径> .venv\Scripts\python.exe tools\probes\verify_metrics.py
"""
import os
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from awpy import Demo  # noqa: E402

from app import parser  # noqa: E402
from app.analysis import metrics  # noqa: E402
from app.analysis.common import RoundIndex, clean_sid, norm_side  # noqa: E402

DEFAULT_DEMO = (r"D:\Steam\steamapps\common\Counter-Strike Global Offensive"
                r"\game\csgo\replays\match730_003831016083200933917_0573296683_401.dem")


def opening_duels(kills, rounds):
    """每回合第一个**敌方**击杀 = 首杀 / 首死（口径对齐 app/analysis/derive.py:278-283）。"""
    index = RoundIndex(rounds)
    first = {}
    for kill in sorted(kills, key=lambda k: k.get("tick") or 0):
        atk = clean_sid(kill.get("attacker_steamid"))
        vic = clean_sid(kill.get("victim_steamid"))
        if not atk or not vic or atk == vic:
            continue
        a_side, v_side = norm_side(kill.get("attacker_side")), norm_side(kill.get("victim_side"))
        if a_side and v_side and a_side == v_side:
            continue  # 友军击杀不算首杀
        rnd = index.round_of(kill.get("tick"))
        if rnd is None or rnd in first:
            continue
        first[rnd] = (atk, vic)

    out = defaultdict(lambda: {"opening_kills": 0, "opening_deaths": 0})
    for atk, vic in first.values():
        out[atk]["opening_kills"] += 1
        out[vic]["opening_deaths"] += 1
    return dict(out)


def main():
    demo_path = os.environ.get("CS2_DEMO") or DEFAULT_DEMO
    demo = Demo(demo_path)
    rounds = parser.records(demo.rounds)
    kills = parser.records(demo.kills)
    stats = parser.records(demo.stats)

    mine = metrics.multikills(kills, rounds)
    open_ = opening_duels(kills, rounds)
    bad = 0
    print("%-18s %-22s %-22s %s" % ("player", "multikill (mine)", "awpy 2k/3k/4k/5k",
                                     "opening K/D mine vs awpy"))
    for s in stats:
        sid = s["steamid"]
        o = mine.get(sid, {"2k": 0, "3k": 0, "4k": 0, "5k": 0})
        a = (s["multikill_2k"], s["multikill_3k"], s["multikill_4k"], s["multikill_5k"])
        m = (o["2k"], o["3k"], o["4k"], o["5k"])
        ok = "" if m == a else "  <== MULTIKILL MISMATCH"
        if ok:
            bad += 1
        op = open_.get(sid, {"opening_kills": 0, "opening_deaths": 0})
        ok2 = ("" if (op["opening_kills"], op["opening_deaths"]) == (s["opening_kills"], s["opening_deaths"])
               else "  <== OPENING MISMATCH")
        if ok2:
            bad += 1
        print("%-18s %-22s %-22s %s/%s vs %s/%s%s%s" % (
            (s["name"] or "")[:18], m, a, op["opening_kills"], op["opening_deaths"],
            s["opening_kills"], s["opening_deaths"], ok, ok2))
    print("total mismatches:", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())