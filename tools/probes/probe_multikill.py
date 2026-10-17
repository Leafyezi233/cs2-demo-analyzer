"""对比 end_tick 与 official_end_tick 两种归回合口径下的多杀差异。

结论（M0 实测）：必须用 official_end_tick，用 end_tick 会漏掉回合结束前后的击杀。
"""
import bisect
import os
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from awpy import Demo  # noqa: E402

from app import parser  # noqa: E402

DEFAULT_DEMO = (r"D:\Steam\steamapps\common\Counter-Strike Global Offensive"
                r"\game\csgo\replays\match730_003831016083200933917_0573296683_401.dem")


def main():
    demo = Demo(os.environ.get("CS2_DEMO") or DEFAULT_DEMO)
    rounds = parser.records(demo.rounds)
    kills = parser.records(demo.kills)
    stats = parser.records(demo.stats)
    print("cols of rounds:", list(rounds[0].keys()))
    for endcol in ("end_tick", "official_end_tick"):
        spans = sorted((r["start_tick"], r[endcol], r["round_num"]) for r in rounds if r.get(endcol))
        starts = [s[0] for s in spans]

        def rnd(tick):
            i = bisect.bisect_right(starts, tick) - 1
            if i < 0:
                return None
            s, e, n = spans[i]
            return n if tick <= e else None

        pr = defaultdict(int)
        unassigned = 0
        for k in kills:
            if not k.get("attacker_steamid"):
                continue
            n = rnd(k["tick"])
            if n is None:
                unassigned += 1
                continue
            pr[(n, k["attacker_steamid"])] += 1
        out = defaultdict(lambda: {"2k": 0, "3k": 0, "4k": 0, "5k": 0})
        for (_n, sid), c in pr.items():
            if c == 2:
                out[sid]["2k"] += 1
            elif c == 3:
                out[sid]["3k"] += 1
            elif c == 4:
                out[sid]["4k"] += 1
            elif c >= 5:
                out[sid]["5k"] += 1
        print("=== by", endcol, "unassigned kills:", unassigned)
        bad = 0
        for s in stats:
            sid = s["steamid"]
            o = out[sid]
            mine = (o["2k"], o["3k"], o["4k"], o["5k"])
            awpy = (s["multikill_2k"], s["multikill_3k"], s["multikill_4k"], s["multikill_5k"])
            flag = "" if mine == awpy else "  <== MISMATCH"
            if flag:
                bad += 1
            print("  %-18s mine=%s awpy=%s%s" % ((s["name"] or "")[:18], mine, awpy, flag))
        print("  mismatches:", bad)


if __name__ == "__main__":
    main()