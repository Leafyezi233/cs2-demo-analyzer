"""按 end_tick / official_end_tick 两种口径逐条对比击杀归属，排查回合边界漏算。"""
import bisect
import os
import sys
from collections import Counter
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

    print("last rounds:")
    for r in rounds[13:]:
        print("  R%-3d start=%-7d end=%-7d official=%-7d" % (
            r["round_num"], r["start_tick"], r["end_tick"], r["official_end_tick"]))

    tid = [s for s in stats if (s["name"] or "").startswith("Triang")][0]["steamid"]
    print("\nTriangulation kills with end_tick / official_end_tick assignment:")
    starts = [r["start_tick"] for r in rounds]
    for k in kills:
        if k["attacker_steamid"] != tid:
            continue
        t = k["tick"]
        i = bisect.bisect_right(starts, t) - 1
        r = rounds[i]
        by_end = r["round_num"] if t <= r["end_tick"] else "next"
        by_off = r["round_num"] if t <= r["official_end_tick"] else "next"
        print("  tick=%-7d victim=%-18s by_end=%-5s by_official=%-5s" % (
            t, (k["victim_name"] or "")[:18], by_end, by_off))

    print("\nper-round counts (official_end_tick):")
    c = Counter()
    for k in kills:
        if k["attacker_steamid"] != tid:
            continue
        t = k["tick"]
        i = bisect.bisect_right(starts, t) - 1
        r = rounds[i]
        if t <= r["official_end_tick"]:
            c[r["round_num"]] += 1
    print(" ", dict(sorted(c.items())))


if __name__ == "__main__":
    main()