"""M1 端到端测试：起服务 -> 解析本机 demo -> 逐个打 API。"""
import json, sys, time, urllib.request

BASE = "http://127.0.0.1:8765"
DEMO = r"D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\match730_003831016083200933917_0573296683_401.dem"

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))

def post(path, data=b""):
    req = urllib.request.Request(BASE + path, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))

print("health:", get("/api/health"))
print("index status:", urllib.request.urlopen(BASE + "/", timeout=30).status)

t = post("/api/demos/local?path=" + urllib.parse.quote(DEMO))
print("submitted:", t)
tid = t["task_id"]
while True:
    task = get("/api/tasks/" + tid)
    print("  task:", task["status"], task["stage"], task["progress"])
    if task["status"] in ("done", "failed"):
        break
    time.sleep(1.5)
if task["status"] == "failed":
    print("TASK ERROR:", task.get("error")); print(task.get("traceback")); sys.exit(1)

mid = task["match_id"]
print("match_id:", mid)
m = get("/api/matches/" + mid)
print("match:", {k: m[k] for k in ("map_name","ct_score","t_score","round_count","tick_rate","parse_seconds")})
print("datasets:", m["datasets"])
players = get("/api/matches/" + mid + "/players")
print("players:", len(players))
for p in players[:4]:
    print("  ", p["name"], p["side"], "rating=", p["rating"], "K/D/A", p["kills"], p["deaths"], p["assists"],
          "adr", p["adr"], "kast", p["kast"], "multikill_calc", p["multikill_calc"], "awpy 2k/3k", p["multikill_2k"], p["multikill_3k"])
rd = get("/api/matches/" + mid + "/rounds")
print("rounds:", len(rd["rounds"]), "economy rows:", len(rd["economy"]))
hm = get("/api/matches/" + mid + "/heatmap?type=kills")
print("heatmap kills:", len(hm["points"]), "sample:", hm["points"][0] if hm["points"] else None)
hs = get("/api/matches/" + mid + "/heatmap?type=shots")
print("heatmap shots:", len(hs["points"]))
mi = None
try:
    mi = get("/api/maps/de_mirage/info")
except Exception as e:
    mi = "ERR " + str(e)
print("map info:", mi)
print("matches list:", get("/api/matches"))
print("OK")
