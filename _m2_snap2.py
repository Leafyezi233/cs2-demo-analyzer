
import sys, time, json
sys.stdout.reconfigure(encoding="utf-8")
from awpy import Demo
p = r"D:\dsh工作区1\cs2-demo-analyzer\数据\demos\match730_003831016083200933917_0573296683_401.dem"
t0=time.perf_counter(); d=Demo(p); r=d.rounds; t1=time.perf_counter()
print("open+rounds:", round(t1-t0,3))
import polars as pl
row = r.filter(pl.col("round_num")==3).to_dicts()[0]
t0=time.perf_counter()
snap = d.snapshots(every=8, start_tick=row["start_tick"], end_tick=row["official_end_tick"])
t1=time.perf_counter()
print("snap every=8:", round(t1-t0,3), "rows:", snap.height)
recs = snap.to_dicts()
for x in recs:
    x["steamid"] = str(x["steamid"])
j = json.dumps(recs, ensure_ascii=False)
print("json bytes:", len(j.encode("utf-8")))
# 长回合
row2 = r.filter(pl.col("round_num")==9).to_dicts()[0]
t0=time.perf_counter()
s2 = d.snapshots(every=8, start_tick=row2["start_tick"], end_tick=row2["official_end_tick"])
print("round9 snap:", round(time.perf_counter()-t0,3), "rows:", s2.height)
print("cols type steamid:", snap.schema["steamid"])
