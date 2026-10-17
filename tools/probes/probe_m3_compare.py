# -*- coding: utf-8 -*-
"""M3 便携包对比页取证：向 dist 实例导入同一 demo 两次，截对比页。"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist" / "CS2数据面板"
EXE = DIST / "CS2数据面板.exe"
LOG = DIST / "日志.txt"
DEMO = ROOT / "数据" / "demos" / "match730_003831016083200933917_0573296683_401.dem"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SHOTS = ROOT / "shots"


def req(base, path, method="GET", body=None):
    r = urllib.request.Request(base + path, method=method, data=body)
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read().decode("utf-8"))


def shot(url, out, size="1600,1200"):
    cmd = [EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
           "--window-size=" + size, "--virtual-time-budget=12000",
           "--screenshot=" + str(out), url]
    subprocess.run(cmd, capture_output=True)
    return out.stat().st_size if out.exists() else -1


def main():
    if LOG.exists():
        LOG.unlink()
    env = dict(os.environ)
    env["CS2_PANEL_NO_OPEN"] = "1"
    proc = subprocess.Popen([str(EXE)], cwd=str(DIST), env=env)
    base = None
    for _ in range(240):
        time.sleep(0.5)
        if LOG.exists():
            txt = LOG.read_text(encoding="utf-8-sig", errors="replace")
            m = re.search(r"(http://127\.0\.0\.1:\d+)", txt)
            if m:
                base = m.group(1) + "/"
                break
        if proc.poll() is not None:
            print("exe 退出 rc =", proc.returncode); print(LOG.read_text(encoding="utf-8-sig", errors="replace")); return 1
    if not base:
        print("未拿到地址"); return 1
    print("base =", base)
    try:
        ids = [m["id"] for m in req(base, "api/matches")]
        print("已有场次", ids)
        while len(ids) < 2:
            t = req(base, "api/demos/local?path=" + urllib.parse.quote(str(DEMO)), method="POST")
            tid = t["task_id"]
            while True:
                time.sleep(1.0)
                st = req(base, "api/tasks/" + tid)
                if st["status"] in ("done", "error"):
                    break
            print("解析", st["status"], st.get("seconds"), st.get("match_id"))
            if st["status"] != "done":
                print(st.get("traceback", "")[-2000:]); return 1
            ids = [m["id"] for m in req(base, "api/matches")]
            print("现有场次", ids)
        c = req(base, "api/compare?ids=" + ",".join(ids[:2]))
        print("compare matches", len(c["matches"]), "p1", len(c["matches"][0]["players"]), "p2", len(c["matches"][1]["players"]))
        for mid in ids[:2]:
            h = req(base, "api/matches/%s/heatmap?type=kills" % mid)
            print("heatmap", mid, "total", h["total"], "points", len(h["points"]))
        u1 = base + "#match=%s&page=compare&sel=%s" % (ids[0], ",".join(ids[:2]))
        print("shot m3-compare.png", shot(u1, SHOTS / "m3-compare.png"), "字节")
        u2 = base + "#match=%s&page=home" % ids[0]
        print("shot m3-home.png", shot(u2, SHOTS / "m3-home.png"), "字节")
        return 0
    finally:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)


if __name__ == "__main__":
    sys.exit(main())