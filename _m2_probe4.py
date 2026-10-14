import json, os, sqlite3, sys, time
sys.path.insert(0, r"D:\dsh工作区1\cs2-demo-analyzer")
DB = r"D:\dsh工作区1\cs2-demo-analyzer\数据\panel.db"
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
mid = con.execute("select id from matches limit 1").fetchone()["id"]
print("match:", mid)
for (name,) in con.execute("select name from datasets where match_id=? order by name", (mid,)):
    payload = con.execute("select payload from datasets where match_id=? and name=?", (mid, name)).fetchone()["payload"]
    rows = json.loads(payload)
    cols = sorted(rows[0].keys()) if rows else []
    print("--- %s: %d rows, %d bytes" % (name, len(rows), len(payload)))
    print("    " + ", ".join(cols))
con.close()

os.environ["AWPY_DATA_DIR"] = r"D:\dsh工作区1\cs2-demo-analyzer\mapdata"
from awpy import Demo
P = r"D:\dsh工作区1\cs2-demo-analyzer\数据\demos\match730_003831016083200933917_0573296683_401.dem"
t0 = time.time(); d = Demo(P); rd = d.rounds
print("open+rounds %.3fs" % (time.time() - t0))
rlist = list(rd.iter_rows(named=True))
r = rlist[2]
print("round3:", r["round_num"], r["start_tick"], r["official_end_tick"])
t0 = time.time()
snap = d.snapshots(every=16, start_tick=r["start_tick"], end_tick=r["official_end_tick"])
print("snapshots %.3fs rows=%d" % (time.time() - t0, snap.height))
print("snap cols:", snap.columns)
import collections
ticks = snap["tick"].to_list()
c = collections.Counter(ticks)
print("distinct ticks:", len(c), "counts:", collections.Counter(c.values()))
hs = snap["health"].to_list()
print("health==0 rows:", sum(1 for h in hs if h == 0), "health min/max:", min(hs), max(hs))
row0 = snap.row(0, named=True)
print("sample row:", json.dumps({k: (str(v) if k in ("steamid",) else v) for k, v in row0.items()}, ensure_ascii=False, default=str))
sides = set(snap["side"].to_list())
print("sides:", sides)
names = sorted(set(snap["name"].to_list()))
print("names:", names)
print("steamid dtype:", snap["steamid"].dtype)