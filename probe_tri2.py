import sys, bisect
sys.path.insert(0, r"D:\dsh工作区1\cs2-demo-analyzer")
from awpy import Demo
from app import parser
DEMO = r"D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\match730_003831016083200933917_0573296683_401.dem"
d = Demo(DEMO)
rounds = parser.records(d.rounds)
kills = parser.records(d.kills)
stats = parser.records(d.stats)
print("last rounds:")
for r in rounds[13:]:
    print("  R%-3d start=%-7d end=%-7d official=%-7d" % (r["round_num"], r["start_tick"], r["end_tick"], r["official_end_tick"]))
tid = [s for s in stats if s["name"].startswith("Triang")][0]["steamid"]
print("\nTriangulation kills with end_tick / official_end_tick assignment:")
starts = [r["start_tick"] for r in rounds]
for k in kills:
    if k["attacker_steamid"] != tid: continue
    t = k["tick"]
    i = bisect.bisect_right(starts, t) - 1
    r = rounds[i]
    byEnd = r["round_num"] if t <= r["end_tick"] else "next"
    byOff = r["round_num"] if t <= r["official_end_tick"] else "next"
    print("  tick=%-7d victim=%-18s by_end=%-5s by_official=%-5s" % (t, (k["victim_name"] or "")[:18], byEnd, byOff))
print("\nper-round counts (official_end_tick):")
from collections import Counter
c = Counter()
for k in kills:
    if k["attacker_steamid"] != tid: continue
    t = k["tick"]
    i = bisect.bisect_right(starts, t) - 1
    r = rounds[i]
    if t <= r["official_end_tick"]:
        c[r["round_num"]] += 1
print(" ", dict(sorted(c.items())))
