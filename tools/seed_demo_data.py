"""造一个装满合成比赛的数据目录，用来预览界面、截图、手工测试（不需要真实 demo）。

用法：
    python tools/seed_demo_data.py 数据_预览 --matches 14
    set CS2_PANEL_DATA_DIR=数据_预览   (PowerShell: $env:CS2_PANEL_DATA_DIR="数据_预览")
    python -m app.main

合成数据里 steamid 76561198000000001（Alpha）是「我」，状态随场次逐渐上升。
生成的 demo 文件只有几个字节，回放页会提示无法解码 —— 这是预期行为。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import ingest  # noqa: E402
from app.devtools import synth  # noqa: E402
from app.store import Store  # noqa: E402


def seed(data_dir: Path, matches: int = 14, seed: int = 7) -> list[str]:
    demo_dir = data_dir / "demos"
    demo_dir.mkdir(parents=True, exist_ok=True)
    store = Store(data_dir / "panel.db")
    now = time.time()
    ids = []
    for i, (parsed, _truth) in enumerate(synth.library(matches, seed=seed)):
        path = demo_dir / f"synthetic_{i + 1:02d}_{parsed['meta']['map_name']}.dem"
        path.write_bytes(b"PBDEMS2\x00synthetic-" + str(i).encode())
        res = ingest.import_demo(store, str(path), managed=True, played_at=now - (matches - i) * 86400 * 2,
                                 parse_fn=lambda _p, progress=None, parsed=parsed: parsed)
        ids.append(res["match_id"])
    return ids


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data_dir", type=Path)
    ap.add_argument("--matches", type=int, default=14)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    ids = seed(args.data_dir, args.matches, args.seed)
    print(f"已写入 {len(ids)} 场合成比赛到 {args.data_dir}（「我」= {synth.steamid(1)}）")


if __name__ == "__main__":
    main()
