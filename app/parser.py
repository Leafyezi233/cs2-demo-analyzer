"""awpy 适配器：把 demo 解析成 {meta, header, datasets, timings, dataset_errors}。

这是全项目唯一 import awpy 解析接口的地方。换解析器（例如 demoparser2）只需要再写一个
返回同样形状的 parse()，派生层与存储层都不用动。

约定（M0 实测得出）：
- 不使用 polars 的 .to_pandas()（awpy 3.0.0 不带 pyarrow，会 ModuleNotFoundError）。
- 所有 *steamid 列一律转成字符串：SteamID64 最大 76561199...，超过 JS Number.MAX_SAFE_INTEGER，
  直接给前端数字会丢精度。
"""
from __future__ import annotations

import time
from typing import Any

# 解析产物形状的版本：本文件的输出口径变化时 +1（库里旧场次会被标记为「可用新解析器重解析」）
PARSER_VERSION = 2

COMBAT = ("rounds", "kills", "damages", "bomb", "shots", "stats", "players", "round_economy", "blinds", "chat")
GRENADE = ("grenades", "fires", "smokes")
ITEMS = ("item_events",)
ALL_DATASETS = COMBAT + GRENADE + ITEMS

# 派生层依赖的列。解析器升级后缺了哪列，会写进解析记录的 warnings，而不是悄悄算出 0
EXPECTED_COLUMNS = {
    "rounds": ("round_num", "start_tick", "end_tick", "official_end_tick", "winner_side", "is_knife_round"),
    "kills": ("tick", "attacker_steamid", "attacker_side", "victim_steamid", "victim_side", "assister_steamid",
              "weapon", "headshot", "is_trade", "victim_traded"),
    "damages": ("tick", "attacker_steamid", "attacker_side", "victim_steamid", "victim_side", "dmg_health",
                "health_pre", "weapon"),
    "item_events": ("tick", "steamid", "side", "action", "cost"),
    "shots": ("tick", "steamid", "side", "weapon"),
    "stats": ("steamid", "rounds_played", "kills", "deaths", "assists", "adr", "kast"),
    "players": ("steamid", "name", "side"),
}


def awpy_version() -> str | None:
    try:
        import awpy
        return getattr(awpy, "__version__", None)
    except Exception:
        return None


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


def column_warnings(datasets: dict[str, list[dict]]) -> list[str]:
    """对照 EXPECTED_COLUMNS 检查数据集，返回人能读懂的告警。空数据集不检查（可能确实没有事件）。"""
    warnings = []
    for name, cols in EXPECTED_COLUMNS.items():
        rows = datasets.get(name)
        if rows is None:
            warnings.append(f"缺少数据集 {name}")
            continue
        if not rows:
            continue
        have = set(rows[0].keys())
        missing = [c for c in cols if c not in have]
        if missing:
            warnings.append(f"{name} 缺少列：{', '.join(missing)}")
    return warnings


def parse(path: str, datasets: tuple[str, ...] = ALL_DATASETS, progress=None) -> dict:
    """解析一场 demo。单个数据集失败不会让整场失败，错误记在 dataset_errors 里。"""
    from awpy import Demo

    t0 = time.perf_counter()
    demo = Demo(path)
    header = dict(demo.header or {})
    timings: dict[str, float] = {}
    errors: dict[str, str] = {}

    data: dict[str, list[dict]] = {}
    for i, name in enumerate(datasets):
        if progress:
            progress(f"解析 {name}", 0.05 + 0.75 * i / len(datasets))
        ts = time.perf_counter()
        try:
            data[name] = records(getattr(demo, name))
        except Exception as exc:
            timings[name] = -1.0
            data[name] = []
            errors[name] = f"{type(exc).__name__}: {exc}"
            continue
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
        "header": {k: _jsonify(v) for k, v in header.items()},
        "datasets": data,
        "timings": timings,
        "dataset_errors": errors,
        "parse_seconds": round(time.perf_counter() - t0, 3),
    }
