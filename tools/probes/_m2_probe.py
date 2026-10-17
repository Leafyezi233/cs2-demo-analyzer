
import json, sqlite3, sys
sys.stdout.reconfigure(encoding="utf-8")
conn = sqlite3.connect(r"D:\dsh工作区1\cs2-demo-analyzer\数据\panel.db")
conn.row_factory = sqlite3.Row
ms = conn.execute("SELECT id,file_name,map_name,ct_score,t_score,round_count,file_size FROM matches").fetchall()
print("MATCHES", len(ms))
for m in ms: print(" ", dict(m))
names = [r["name"] for r in conn.execute("SELECT name FROM datasets WHERE match_id=?", (ms[0]["id"],))]
print("DATASETS", names)
for n in ["kills","shots","rounds","round_economy","stats","players","bomb","damages","grenades","smokes","fires","blinds","chat","item_events"]:
    r = conn.execute("SELECT payload FROM datasets WHERE match_id=? AND name=?", (ms[0]["id"], n)).fetchone()
    if not r: print(n, "MISSING"); continue
    rows = json.loads(r["payload"])
    print(n, "rows=", len(rows), "keys=", list(rows[0].keys()) if rows else None)
