"""awpy 3.0.0 适配器：把 demo 解析成前端可用的 JSON 形状。

约定（M0 实测得出）：
- 不使用 polars 的 .to_pandas()（awpy 3.0.0 不带 pyarrow，会 ModuleNotFoundError）。
- 所有 *steamid 列一律转成字符串：SteamID64 最大 76561199...，超过 JS Number.MAX_SAFE_INTEGER，
  直接给前端数字会丢精度。
"""
from __future__ import annotations

import time
from typing import Any

from awpy import Demo

# 这些数据集在 M0 实测中确认存在且有用
COMBAT = ("rounds", "kills", "damages", "bomb", "shots", "stats", "players", "round_economy", "blinds", "chat")
GRENADE = ("grenades", "fires", "smokes")
ITEMS = ("item_events",)
ALL_DATASETS = COMBAT + GRENADE + ITEMS


def _jsonify(value: Any) -> Any:
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    return value


def records(df) -> list[dict]:
    """polars DataFrame -> JSON 安全的 list[dict]。"""
    out: list[dict] = []
    for row in df.iter_rows(named=True):
        d: dict[str, Any] = {}
        for key, value in row.items():
            if key.endswith("steamid"):
                d[key] = None if value is None else str(value)
            else:
                d[key] = _jsonify(value)
        out.append(d)
    return out


def parse(path: str, datasets: tuple[str, ...] = ALL_DATASETS) -> dict:
    """解析一场 demo，返回 {meta, datasets, timings}。"""
    t0 = time.perf_counter()
    demo = Demo(path)
    header = dict(demo.header or {})
    timings: dict[str, float] = {}

    data: dict[str, list[dict]] = {}
    for name in datasets:
        ts = time.perf_counter()
        try:
            df = getattr(demo, name)
        except Exception as exc:  # 数据集缺失不应让整场解析失败
            timings[name] = -1.0
            data[name] = []
            header.setdefault("_dataset_errors", {})[name] = f"{type(exc).__name__}: {exc}"
            continue
        data[name] = records(df)
        timings[name] = round(time.perf_counter() - ts, 3)

    meta = {
        "map_name": header.get("map_name"),
        "server_name": header.get("server_name"),
        "client_name": header.get("client_name"),
        "demo_version_name": header.get("demo_version_name"),
        "build_num": header.get("build_num"),
        "playback_ticks": header.get("playback_ticks"),
        "playback_time": header.get("playback_time"),
        "tick_rate": float(demo.tick_rate) if demo.tick_rate else None,
    }
    return {
        "meta": meta,
        "header": {k: _jsonify(v) for k, v in header.items() if k != "_dataset_errors"},
        "datasets": data,
        "timings": timings,
        "parse_seconds": round(time.perf_counter() - t0, 3),
    }
