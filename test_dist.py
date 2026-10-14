# -*- coding: utf-8 -*-
"""便携包端到端验证：启动 dist 内的服务，走 health -> 解析真实 demo -> 各 API。"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(r"D:\dsh工作区1\cs2-demo-analyzer")
DIST = ROOT / "dist" / "CS2数据面板"
PYEXE = DIST / "runtime" / "python.exe"
DEMO = ROOT / "数据" / "demos" / "match730_003831016083200933917_0573296683_401.dem"
PORT = 8799
BASE = "http://127.0.0.1:%d" % PORT


def get(path, method="GET", body=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method, data=body,
                                 headers=headers or {})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    env = dict(os.environ)
    env.pop("PYTHONHOME", None); env.pop("PYTHONPATH", None)
    env["PYTHONUTF8"] = "1"; env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["CS2_PANEL_PORT"] = str(PORT); env["CS2_PANEL_NO_BROWSER"] = "1"
    log = open(ROOT / "_dist_server.log", "wb")
    p = subprocess.Popen([str(PYEXE), "-m", "app.main"], cwd=str(DIST),
                         stdout=log, stderr=subprocess.STDOUT, env=env)
    try:
        ok = False
        for _ in range(60):
            time.sleep(0.5)
            try:
                h = get("/api/health"); ok = True; break
            except Exception:
                if p.poll() is not None:
                    break
        if not ok:
            print("服务未起来，rc =", p.poll())
            print(open(ROOT / "_dist_server.log", encoding="utf-8", errors="replace").read()[-4000:])
            return 1
        print("health:", json.dumps(h, ensure_ascii=False))
        print("首页 HTTP 状态:", end=" ")
        with urllib.request.urlopen(BASE + "/", timeout=30) as r:
            print(r.status, len(r.read()), "bytes")

        print("\n提交解析任务 ...")
        t = get("/api/demos/local?path=" + urllib.parse.quote(str(DEMO)), method="POST")
        tid = t["task_id"]; print("task:", tid)
        while True:
            time.sleep(1.0)
            st = get("/api/tasks/" + tid)
            if st["status"] in ("done", "error"):
                break
        print("status:", st["status"], "seconds:", st.get("seconds"), "stage:", st.get("stage"))
        if st["status"] != "done":
            print("error:", st.get("error")); print(st.get("traceback", "")[-3000:]); return 1
        mid = st["match_id"]; print("match_id:", mid)

        m = get("/api/matches/" + mid)
        print("match:", m["map_name"], "CT", m["ct_score"], "T", m["t_score"],
              "rounds", m["round_count"], "datasets", len(m["datasets"]))
        pl = get("/api/matches/" + mid + "/players")
        print("players:", len(pl))
        k = get("/api/matches/" + mid + "/heatmap?type=kills")
        print("heatmap kills:", k["total"], "filtered", k["filtered"])
        mi = get("/api/maps/de_mirage/info")
        print("map info:", json.dumps({x: mi[x] for x in ("scale", "offset_x", "offset_y", "radar_size")}, ensure_ascii=False))
        rp = get("/api/matches/" + mid + "/replay/3?every=16")
        print("replay r3:", "ticks", len(rp["ticks"]), "players", len(rp["players"]),
              "cached", rp.get("cached"), "build", rp.get("build_seconds"))
        wp = get("/api/matches/" + mid + "/weapons")
        print("weapons:", len(wp["weapons"]), wp["weapons"][:3])
        cmp_ = get("/api/compare?ids=" + mid)
        print("compare:", len(cmp_["matches"]))
        print("\n缓存目录:", (DIST / "数据" / "replay_cache").exists())
        print("库文件:", (DIST / "数据" / "panel.db").exists(),
              (DIST / "数据" / "panel.db").stat().st_size if (DIST / "数据" / "panel.db").exists() else 0)
        return 0
    finally:
        p.terminate()
        try:
            p.wait(timeout=15)
        except Exception:
            p.kill()
        log.close()


if __name__ == "__main__":
    sys.exit(main())
