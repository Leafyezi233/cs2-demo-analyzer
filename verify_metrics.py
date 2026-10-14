import sys
sys.path.insert(0, r"D:\dsh工作区1\cs2-demo-analyzer")
from awpy import Demo
from app import metrics, parser
DEMO = r"D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\match730_003831016083200933917_0573296683_401.dem"
d = Demo(DEMO)
rounds = parser.records(d.rounds)
kills = parser.records(d.kills)
stats = parser.records(d.stats)
mine = metrics.multikills(kills, rounds)
open_ = metrics.opening_duels(kills, rounds)
bad = 0
print("%-18s %-22s %-22s %s" % ("player", "multikill (mine)", "awpy 2k/3k/4k/5k", "opening K/D mine vs awpy"))
for s in stats:
    sid = s["steamid"]
    o = mine.get(sid, {"2k":0,"3k":0,"4k":0,"5k":0})
    a = (s["multikill_2k"], s["multikill_3k"], s["multikill_4k"], s["multikill_5k"])
    m = (o["2k"], o["3k"], o["4k"], o["5k"])
    ok = "" if m == a else "  <== MULTIKILL MISMATCH"
    if ok: bad += 1
    op = open_.get(sid, {"opening_kills":0,"opening_deaths":0})
    ok2 = "" if (op["opening_kills"], op["opening_deaths"]) == (s["opening_kills"], s["opening_deaths"]) else "  <== OPENING MISMATCH"
    if ok2: bad += 1
    print("%-18s %-22s %-22s %s/%s vs %s/%s%s%s" % (
        s["name"][:18], m, a, op["opening_kills"], op["opening_deaths"],
        s["opening_kills"], s["opening_deaths"], ok, ok2))
print("total mismatches:", bad)
