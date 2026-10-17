import sys, bisect
sys.path.insert(0, r"D:\dsh工作区1\cs2-demo-analyzer")
from awpy import Demo
from app import parser
DEMO = r"D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\match730_003831016083200933917_0573296683_401.dem"
d = Demo(DEMO)
rounds = parser.records(d.rounds)
kills = parser.records(d.kills)
stats = parser.records(d.stats)

target = [s for s in stats if s["name"].startswith("Triang")][0]
print("Triangulation:", target["steamid"], "kills", target["kills"], "multikill awpy",
      target["multikill_2k"], target["multikill_3k"])

print("\nround windows (round_num, start, end, official_end, knife):")
for r in rounds:
    print("  R%-3d start=%-7d end=%-7d official=%-7d knife=%s winner=%s reason=%s" %
          (r["round_num"], r["start_tick"], r["end_tick"], r["official_end_tick"], r["is_knife_round"],
           r["winner_side"], r["reason_name"]))

print("\nTriangulation kills:")
for k in kills:
    if k["attacker_steamid"] == target["steamid"]:
        print("  tick=%-7d victim=%-18s weapon=%-14s hs=%s" % (k["tick"], (k["victim_name"] or "")[:18], k["weapon"], k["headshot"]))

print("\nall kills with tick > 100000 or in last rounds:")
for k in kills:
    if k["tick"] > 95000:
        print("  tick=%-7d atk=%-18s vic=%-18s" % (k["tick"], (k["attacker_name"] or "")[:18], (k["victim_name"] or "")[:18]))
