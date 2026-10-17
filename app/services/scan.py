"""扫描本机 CS2 录像：先找 Steam 安装位置，再读 libraryfolders.vdf 找到所有库目录。

旧实现写死了 D:\\Steam，换盘符或装在别处就扫不到。现在的顺序：
1. 环境变量 CS2_PANEL_SCAN_DIRS / 设置页里的额外目录
2. 常见 Steam 安装位置（Windows / Linux / macOS）及其 libraryfolders.vdf 里登记的全部库
3. 每个库下的 steamapps/common/Counter-Strike Global Offensive/game/csgo（replays 与根目录）
"""
from __future__ import annotations

import glob
import os
import re
from pathlib import Path

CS2_REL = Path("steamapps") / "common" / "Counter-Strike Global Offensive" / "game" / "csgo"
_PATH_RE = re.compile(r'"path"\s+"((?:[^"\\]|\\.)*)"')


def steam_roots() -> list[Path]:
    env = os.environ
    cands = [
        env.get("ProgramFiles(x86)", r"C:\Program Files (x86)") + r"\Steam",
        env.get("ProgramFiles", r"C:\Program Files") + r"\Steam",
        r"D:\Steam", r"E:\Steam", r"D:\SteamLibrary", r"E:\SteamLibrary",
        "~/.steam/steam", "~/.local/share/Steam", "~/Library/Application Support/Steam",
    ]
    out = []
    for c in cands:
        p = Path(os.path.expanduser(c))
        if p.is_dir() and p not in out:
            out.append(p)
    return out


def parse_library_folders(text: str) -> list[str]:
    """从 libraryfolders.vdf 文本里取出全部 "path"（反斜杠转义按 VDF 规则还原）。"""
    return [m.group(1).replace("\\\\", "\\") for m in _PATH_RE.finditer(text)]


def library_dirs(roots: list[Path] | None = None) -> list[Path]:
    libs: list[Path] = []
    for root in roots if roots is not None else steam_roots():
        if root not in libs:
            libs.append(root)
        vdf = root / "steamapps" / "libraryfolders.vdf"
        try:
            text = vdf.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for path in parse_library_folders(text):
            p = Path(path)
            if p not in libs:
                libs.append(p)
    return libs


def candidate_dirs(extra: list[str] | tuple[str, ...] = (), roots: list[Path] | None = None) -> list[Path]:
    dirs = [Path(os.path.expanduser(e)) for e in extra if e]
    for lib in library_dirs(roots):
        base = lib / CS2_REL
        dirs += [base / "replays", base]
    seen, out = set(), []
    for d in dirs:
        key = str(d).lower()
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def scan(extra: list[str] | tuple[str, ...] = (), roots: list[Path] | None = None, limit: int = 200) -> dict:
    checked = candidate_dirs(extra, roots)
    found: dict[str, dict] = {}
    for d in checked:
        if not d.is_dir():
            continue
        for path in glob.glob(os.path.join(str(d), "*.dem")):
            try:
                st = os.stat(path)
            except OSError:
                continue
            found[os.path.normcase(os.path.abspath(path))] = {
                "path": path, "name": os.path.basename(path), "size": st.st_size, "mtime": st.st_mtime,
            }
    items = sorted(found.values(), key=lambda f: f["mtime"], reverse=True)
    return {"roots_checked": [str(d) for d in checked], "existing": [str(d) for d in checked if d.is_dir()],
            "found": items[:limit], "total": len(items)}
