
import sys, time, json
sys.stdout.reconfigure(encoding="utf-8")
from awpy import Demo
p = r"D:\dsh工作区1\cs2-demo-analyzer\数据\demos\match730_003831016083200933917_0573296683_401.dem"
d = Demo(p)
print("rounds cols ok")
import polars as pl
r = d.rounds
row = r.filter(pl.col("round_num") == 3).to_dicts()[0]
print("round3:", json.dumps({k: row[k] for k in ("round_num","start_tick","freeze_end_tick","end_tick","official_end_tick")}))
s, e = row["start_tick"], row["official_end_tick"]
t0 = time.perf_counter()
snap = d.snapshots(every=8, start_tick=s, end_tick=e)
t1 = time.perf_counter()
print("snapshot rows:", snap.height, "cols:", snap.columns)
print("elapsed every=8:", round(t1-t0, 2), "s")
print("sample:", json.dumps(snap.head(2).to_dicts(), ensure_ascii=False)[:600])
t0 = time.perf_counter()
snap2 = d.snapshots(every=16, start_tick=s, end_tick=e)
print("every=16 rows:", snap2.height, "elapsed:", round(time.perf_counter()-t0,2))
t0 = time.perf_counter()
snap3 = d.snapshots(every=4, start_tick=s, end_tick=e)
print("every=4 rows:", snap3.height, "elapsed:", round(time.perf_counter()-t0,2))
