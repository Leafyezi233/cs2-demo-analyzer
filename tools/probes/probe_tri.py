"""打印单个玩家的击杀与回合窗口，用来排查多杀口径。"""
import os
import sys
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

    target = [s for s in stats if (s["name"] or "").startswith("Triang")][0]
    print("Triangulation:", target["steamid"], "kills", target["kills"], "multikill awpy",
          target["multikill_2k"], target["multikill_3k"])

    print("\nround windows (round_num, start, end, official_end, knife):")
    for r in rounds:
        print("  R%-3d start=%-7d end=%-7d official=%-7d knife=%s winner=%s reason=%s" % (
            r["round_num"], r["start_tick"], r["end_tick"], r["official_end_tick"],
            r["is_knife_round"], r["winner_side"], r["reason_name"]))

    print("\nTriangulation kills:")
    for k in kills:
        if k["attacker_steamid"] == target["steamid"]:
            print("  tick=%-7d victim=%-18s weapon=%-14s hs=%s" % (
                k["tick"], (k["victim_name"] or "")[:18], k["weapon"], k["headshot"]))

    print("\nall kills with tick > 95000:")
    for k in kills:
        if k["tick"] > 95000:
            print("  tick=%-7d atk=%-18s vic=%-18s" % (
                k["tick"], (k["attacker_name"] or "")[:18], (k["victim_name"] or "")[:18]))


if __name__ == "__main__":
    main()