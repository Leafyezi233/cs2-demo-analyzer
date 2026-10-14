
import json, sqlite3, sys
from collections import Counter
sys.stdout.reconfigure(encoding="utf-8")
conn = sqlite3.connect(r"D:\dsh工作区1\cs2-demo-analyzer\数据\panel.db")
conn.row_factory = sqlite3.Row
mid = conn.execute("SELECT id FROM matches LIMIT 1").fetchone()["id"]
def ds(n):
    r = conn.execute("SELECT payload FROM datasets WHERE match_id=? AND name=?", (mid, n)).fetchone()
    return json.loads(r["payload"]) if r else []
bomb = ds("bomb"); gren = ds("grenades"); smk = ds("smokes"); fir = ds("fires"); blinds = ds("blinds")
print("bomb events:", Counter(b["event"] for b in bomb).most_common())
print("bomb sample:", json.dumps(bomb[:3], ensure_ascii=False))
print("bomb bombsite:", Counter(str(b.get("bombsite")) for b in bomb).most_common())
print("grenade types:", Counter(g["type"] for g in gren).most_common())
print("grenade distinct entities:", len(set((g["entity_id"], g["entity_serial"]) for g in gren)))
print("smoke sample:", json.dumps(smk[0], ensure_ascii=False))
print("fire sample:", json.dumps(fir[0], ensure_ascii=False))
print("fire types:", Counter(f["type"] for f in fir).most_common())
print("blinds sample:", json.dumps(blinds[0], ensure_ascii=False))
print("blinds duration range:", min(b["duration"] for b in blinds), max(b["duration"] for b in blinds))
