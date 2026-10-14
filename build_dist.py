# -*- coding: utf-8 -*-
"""构建 CS2 数据面板便携发行包（全程离线：本地 uv Python + 本地 .venv 的 site-packages）"""
import os, shutil, subprocess, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist" / "CS2数据面板"
VENV_SP = ROOT / ".venv" / "Lib" / "site-packages"
MAPSRC = ROOT / "mapdata" / "2000930"

DROP_PY_DIRS = {"tcl", "include", "libs", "site-packages",
                "ensurepip", "idlelib", "test", "pydoc_data", "venv",
                "turtledemo", "tkinter", "unittest"}
DROP_PY_FILES = {"tk86t.dll", "tcl86t.dll", "_tkinter.pyd",
                 "_testcapi.pyd", "_testlimitedcapi.pyd", "_testclinic.pyd",
                 "_testinternalcapi.pyd", "_testbuffer.pyd", "_testmultiphase.pyd",
                 "_testimportmultiple.pyd", "_testconsole.pyd"}


def _find_pysrc():
    cands = []
    for base in (os.environ.get("APPDATA"), os.environ.get("LOCALAPPDATA")):
        if base:
            cands.append(Path(base) / "uv" / "python" / "cpython-3.13.15-windows-x86_64-none")
    cands.append(Path("%USERPROFILE%/AppData/Roaming/uv/python/cpython-3.13.15-windows-x86_64-none"))
    for c in cands:
        if c.is_dir():
            return c
    raise SystemExit("找不到 uv 的 cpython-3.13.15 安装目录，检查过的路径：" + " / ".join(str(c) for c in cands))


PYSRC = _find_pysrc()


def size_of(path):
    path = Path(path)
    if not path.exists():
        return -1
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


def copy_python(dst):
    def ignore(dirpath, names):
        cur = Path(dirpath)
        skip = set()
        for n in names:
            full = cur / n
            if full.is_dir():
                if n in DROP_PY_DIRS or n == "__pycache__":
                    skip.add(n)
            elif n in DROP_PY_FILES:
                skip.add(n)
        return skip
    shutil.copytree(PYSRC, dst, ignore=ignore, dirs_exist_ok=True)


def copy_site_packages(dst):
    dst.mkdir(parents=True, exist_ok=True)
    for item in VENV_SP.iterdir():
        if item.name.startswith("pip") or item.name == "README.txt" or item.name == "__pycache__":
            continue
        tgt = dst / item.name
        if item.is_dir():
            shutil.copytree(item, tgt, ignore=shutil.ignore_patterns("__pycache__"), dirs_exist_ok=True)
        else:
            shutil.copy2(item, tgt)


def copy_app(dst):
    shutil.copytree(ROOT / "app", dst,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"), dirs_exist_ok=True)


def copy_mapdata(dst):
    (dst / "2000930").mkdir(parents=True, exist_ok=True)
    for name in ("geometry", "navs", "radars"):
        src = MAPSRC / name
        if src.is_dir():
            shutil.copytree(src, dst / "2000930" / name, dirs_exist_ok=True)
    for name in (".geometry.zip.done", ".navs.zip.done", ".images.zip.done",
                 "manifest.json", "map_data.json"):
        src = MAPSRC / name
        if src.exists():
            shutil.copy2(src, dst / "2000930" / name)


BAT_LINES = [
    "@echo off",
    "chcp 65001 >nul",
    'cd /d "%~dp0"',
    "runtime\\python.exe -m app.main",
]

README = [
    "CS2 数据面板 —— 使用说明",
    "",
    "1. 双击本目录下的「CS2数据面板.exe」。",
    "2. 浏览器会自动打开 http://127.0.0.1:8765/（若没有自动打开，请手动访问该地址）。",
    "3. 把 .dem 录像文件拖进网页的上传区即可开始分析。",
    "4. 程序会缩到右下角系统托盘，右键托盘图标可以打开面板 / 打开数据目录 / 退出。",
    "5. 若启动失败，请看同目录下的「日志.txt」。",
    "",
    "本目录自带 Python 运行时与地图资产，无需安装任何东西，也不需要联网。",
    "",
    "常见问题：",
    "- 杀毒软件 / Windows SmartScreen 提示风险：本程序未做代码签名，选择「更多信息 → 仍要运行」即可。",
    "- 端口被占用：程序会自动改用 8765-8784 之间的空闲端口。",
    "- 只支持 Counter-Strike 2（Source 2）的 .dem，不支持 CS:GO 老格式。",
]


def build_launcher(dst):
    """用系统自带的 csc.exe 编译无控制台窗口的启动器（离线，无需 SDK）。"""
    csc = Path(os.environ.get("WINDIR", "C:/Windows")) / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe"
    if not csc.exists():
        print("  [跳过] 未找到 csc.exe：" + str(csc))
        return False
    cs = ROOT / "launcher" / "Launcher.cs"
    out = dst / "CS2数据面板.exe"
    cmd = [str(csc), "/nologo", "/target:winexe", "/codepage:65001",
           "/out:" + str(out),
           "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
           str(cs)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or not out.exists():
        print("  [失败] csc rc=" + str(r.returncode))
        print((r.stdout or "")[-2000:])
        print((r.stderr or "")[-2000:])
        return False
    print("  [完成] " + out.name + " (" + format(out.stat().st_size, ",") + " 字节)")
    return True


def main():
    t0 = time.time()
    print("[1/7] 清理 dist ...")
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    print("[2/7] 复制 Python 运行时 ...")
    copy_python(DIST / "runtime")

    print("[3/7] 复制 site-packages ...")
    copy_site_packages(DIST / "runtime" / "Lib" / "site-packages")

    print("[4/7] 复制应用源码 ...")
    copy_app(DIST / "app")

    print("[5/7] 复制地图资产 ...")
    copy_mapdata(DIST / "mapdata")

    print("[6/7] 生成启动脚本与说明 ...")
    (DIST / "启动.bat").write_bytes(("\r\n".join(BAT_LINES) + "\r\n").encode("gbk"))
    (DIST / "使用说明.txt").write_text("\r\n".join(README) + "\r\n", encoding="utf-8")

    print("[7/7] 编译启动器 exe ...")
    build_launcher(DIST)

    print()
    print("=== 体积 ===")
    for name in ("runtime", "app", "mapdata"):
        s = size_of(DIST / name)
        print("%-12s %14s  (%.1f MB)" % (name, format(s, ","), s / 1048576))
    total = size_of(DIST)
    print("%-12s %14s  (%.1f MB)" % ("TOTAL", format(total, ","), total / 1048576))
    print("elapsed %.1fs" % (time.time() - t0))

    print()
    print("=== 运行时自检 ===")
    py = DIST / "runtime" / "python.exe"
    env = dict(os.environ)
    env.pop("PYTHONHOME", None)
    env.pop("PYTHONPATH", None)
    env["PYTHONUTF8"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    probe = (
        "import sys; print('prefix', sys.prefix); print('ver', sys.version.split()[0]);"
        "print('sp', [p for p in sys.path if 'site-packages' in p]);"
        "import polars, fastapi, uvicorn, pydantic, starlette;"
        "print('polars', polars.__version__); print('fastapi', fastapi.__version__);"
        "print('uvicorn', uvicorn.__version__); print('pydantic', pydantic.VERSION);"
        "print('starlette', starlette.__version__)"
    )
    r = subprocess.run([str(py), "-c", probe], cwd=str(DIST),
                       capture_output=True, text=True, encoding="utf-8", env=env)
    print("rc", r.returncode)
    print(r.stdout)
    if r.stderr:
        print("[stderr]", r.stderr[-3000:])


if __name__ == "__main__":
    main()
