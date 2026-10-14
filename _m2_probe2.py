
import json, sqlite3, sys
from collections import Counter
sys.stdout.reconfigure(encoding="utf-8")
conn = sqlite3.connect(r"D:\dsh工作区1\cs2-demo-analyzer\数据\panel.db")
conn.row_factory = sqlite3.Row
mid = conn.execute("SELECT id FROM matches LIMIT 1").fetchone()["id"]
def ds(n):
    r = conn.execute("SELECT payload FROM datasets WHERE match_id=? AND name=?", (mid, n)).fetchone()
    return json.loads(r["payload"]) if r else []
kills = ds("kills"); shots = ds("shots"); rounds = ds("rounds")
print("kill weapons:", Counter(k["weapon"] for k in kills).most_common())
print("shot weapons:", Counter(s["weapon"] for s in shots).most_common(12))
print("kill sides:", Counter(k["attacker_side"] for k in kills))
print("kill hitgroup:", Counter(k["hitgroup_name"] for k in kills).most_common())
# per-round kill counts using official_end_tick
spans = sorted((r["start_tick"], r.get("official_end_tick") or r["end_tick"], r["round_num"]) for r in rounds)
def rnd_of(t):
    for s,e,n in spans:
        if s <= t <= e: return n
    return None
c = Counter(rnd_of(k["tick"]) for k in kills)
print("kills per round:", sorted(c.items(), key=lambda x: (x[0] is None, x[0])))
print("rounds sample:", json.dumps(rounds[0], ensure_ascii=False))
print("economy sample:", json.dumps(ds("round_economy")[0], ensure_ascii=False))
print("distinct tick range:", min(k["tick"] for k in kills), max(k["tick"] for k in kills))
print("first 3 kills:", json.dumps([{k2:k[v] for k2,v in [("t","tick"),("a","attacker_name"),("v","victim_name"),("w","weapon")]} for k in kills[:3]], ensure_ascii=False))
print("players:", json.dumps(ds("players"), ensure_ascii=False))
