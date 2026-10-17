# -*- coding: utf-8 -*-
"""便携包「真实启动路径」验收：跑 CS2数据面板.exe（非 --check），走 API 并截图。"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "dist" / "CS2数据面板"
EXE = DIST / "CS2数据面板.exe"
LOG = DIST / "日志.txt"
DEMO = ROOT / "数据" / "demos" / "match730_003831016083200933917_0573296683_401.dem"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SHOTS = ROOT / "shots"


def req(base, path, method="GET", body=None):
    r = urllib.request.Request(base + path, method=method, data=body)
    with urllib.request.urlopen(r, timeout=180) as resp:
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
    for _ in range(180):
        time.sleep(0.5)
        if LOG.exists():
            txt = LOG.read_text(encoding="utf-8-sig", errors="replace")
            m = re.search(r"(http://127\.0\.0\.1:\d+)", txt)
            if m:
                base = m.group(1) + "/"
                break
        if proc.poll() is not None:
            print("exe 已退出，rc =", proc.returncode)
            print(LOG.read_text(encoding="utf-8-sig", errors="replace") if LOG.exists() else "")
            return 1
    if not base:
        print("120 秒内未拿到地址"); print(LOG.read_text(encoding="utf-8-sig", errors="replace")); return 1
    print("base =", base)
    try:
        print("health:", json.dumps(req(base, "api/health"), ensure_ascii=False))
        t = req(base, "api/demos/local?path=" + urllib.parse.quote(str(DEMO)), method="POST")
        tid = t["task_id"]
        while True:
            time.sleep(1.0)
            st = req(base, "api/tasks/" + tid)
            if st["status"] in ("done", "failed"):
                break
        print("task", st["status"], st.get("seconds"), "match", st.get("match_id"))
        if st["status"] != "done":
            print(st.get("traceback", "")[-3000:]); return 1
        mid = st["match_id"]
        print("players", len(req(base, "api/matches/" + mid + "/players")))
        SHOTS.mkdir(exist_ok=True)
        for name, frag in (("m3-home.png", "#match=%s&page=home" % mid),
                           ("m3-map.png", "#match=%s&page=map&heat=kills" % mid),
                           ("m3-replay.png", "#match=%s&page=replay&frame=120" % mid),
                           ("m3-compare.png", "#match=%s&page=compare&sel=%s" % (mid, mid))):
            n = shot(base + frag, SHOTS / name)
            print("shot", name, n, "字节")
        print("日志尾部：")
        print("\n".join(LOG.read_text(encoding="utf-8-sig", errors="replace").splitlines()[-6:]))
        return 0
    finally:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)


if __name__ == "__main__":
    sys.exit(main())
