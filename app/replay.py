"""回合回放：把 awpy 的 snapshots 压成前端可播放的紧凑轨迹。

设计取舍（M2 实测）：
- awpy 的 snapshots() 每次调用都重新解码，**结果不缓存**；单回合 every=8 约 0.2s，
  但同一回合被反复请求（拖动时间轴、切回合再切回来）会浪费。因此这里落盘缓存。
- snapshots 原始 39 列、每 tick 每玩家一行，单回合全量 JSON 约 7 MB，不能直接给前端。
  只保留播放需要的 5 个量：x, y, health, 状态位掩码, yaw（用于画朝向）。
- 坐标取整（CS2 世界坐标精度到 1 单位足够画图），血量取整。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

# 状态位掩码：前端按位取值，避免每帧带一堆布尔字段
FLAGS = {
    "is_crouched": 1,
    "is_walking": 2,
    "is_jumping": 4,
    "is_blinded": 8,
    "is_defusing": 16,
    "has_bomb": 32,
    "is_scoped": 64,
    "is_reloading": 128,
}

# every 的合法范围：2 太密（单回合 4 万行），32 太疏（看不清走位）
EVERY_MIN = 2
EVERY_MAX = 32
EVERY_DEFAULT = 8


def clamp_every(every: Any) -> int:
    try:
        value = int(every)
    except (TypeError, ValueError):
        return EVERY_DEFAULT
    return max(EVERY_MIN, min(EVERY_MAX, value))


def _cache_path(cache_dir: Path, match_id: str, round_num: int, every: int) -> Path:
    return cache_dir / match_id / f"r{round_num}_e{every}.json"


def _flags(row: dict) -> int:
    bits = 0
    for key, bit in FLAGS.items():
        if row.get(key):
            bits |= bit
    return bits


def pack(rows: list[dict], round_row: dict, every: int, tick_rate: float | None) -> dict:
    """把 snapshots 行压成 {ticks, players[frames]} 的紧凑结构。"""
    ticks: list[int] = sorted({int(r["tick"]) for r in rows if r.get("tick") is not None})
    index = {tick: i for i, tick in enumerate(ticks)}

    players: dict[str, dict] = {}
    for row in rows:
        tick = row.get("tick")
        if tick is None:
            continue
        steamid = row.get("steamid")
        steamid = None if steamid is None else str(steamid)
        if steamid is None:
            continue
        entry = players.get(steamid)
        if entry is None:
            entry = {"steamid": steamid, "name": row.get("name"), "side": row.get("side"), "frames": [None] * len(ticks)}
            players[steamid] = entry
        x, y = row.get("x"), row.get("y")
        if x is None or y is None:
            continue
        yaw = row.get("yaw")
        entry["frames"][index[int(tick)]] = [
            int(round(x)), int(round(y)), int(row.get("health") or 0), _flags(row),
            None if yaw is None else int(round(yaw)),
        ]

    return {
        "round_num": round_row.get("round_num"),
        "start_tick": round_row.get("start_tick"),
        "end_tick": round_row.get("official_end_tick") or round_row.get("end_tick"),
        "every": every,
        "tick_rate": tick_rate,
        "ticks": ticks,
        "players": sorted(players.values(), key=lambda p: (p["side"] or "", p["name"] or "")),
    }


def build(
    demo_path: str,
    round_row: dict,
    every: int,
    cache_dir: Path,
    match_id: str,
    tick_rate: float | None = None,
) -> dict:
    """取单回合轨迹；优先读磁盘缓存。"""
    every = clamp_every(every)
    path = _cache_path(cache_dir, match_id, int(round_row["round_num"]), every)
    if path.is_file():
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            cached["cached"] = True
            return cached
        except (OSError, ValueError):
            pass  # 缓存损坏则重算

    if not os.path.isfile(demo_path):
        raise FileNotFoundError(f"demo 文件已不在原路径：{demo_path}")

    from awpy import Demo  # 延迟导入：避免没有 mapdata 时也拖慢启动

    start_tick = int(round_row.get("start_tick") or 0)
    end_tick = int(round_row.get("official_end_tick") or round_row.get("end_tick") or 0)
    t0 = time.perf_counter()
    demo = Demo(demo_path)
    snap = demo.snapshots(every=every, start_tick=start_tick, end_tick=end_tick)
    rows = list(snap.iter_rows(named=True))
    packed = pack(rows, round_row, every, tick_rate)
    packed["build_seconds"] = round(time.perf_counter() - t0, 3)
    packed["cached"] = False

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(packed, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)
    return packed
