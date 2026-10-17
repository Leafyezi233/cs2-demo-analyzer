"""规则发现引擎：把聚合数字变成一份结构化「发现清单」（纯规则，无 AI，可复现）。

原则：
- 样本不足就闭嘴：场次 / 回合 / 开枪数没到门槛的维度只报「样本不足」，不下结论。
- 基线用中位数 + MAD（不是均值），单场炸裂或梦游不会把基线带偏。
- 每条发现都带原始数字（value / baseline / evidence），AI 叙述层只能引用这些数字，不能自己算。
"""
from __future__ import annotations

import statistics
from typing import Any

from ..services import stats
from ..store import Store

ENGINE_VERSION = 1
BASELINE_MIN = 5          # 至少 5 场历史才做「本场 vs 基线」
BASELINE_WINDOW = 10      # 基线取最近 10 场
Z_THRESHOLD = 2.0
TREND_RUN = 4             # 连续 4 场下滑/上升才算趋势
METRIC_LABEL = {"rating": "Rating≈", "adr": "ADR", "kast": "KAST", "headshot_pct": "爆头率"}


def robust_z(value: float, history: list[float]) -> tuple[float | None, float, float]:
    """返回 (z, 中位数, MAD)。MAD 为 0（历史完全一样）时 z 为 None。"""
    med = statistics.median(history)
    mad = statistics.median(abs(x - med) for x in history)
    if mad == 0:
        return None, med, mad
    return 0.6745 * (value - med) / mad, med, mad


def _f(value: Any, digits: int = 2) -> str:
    return "-" if value is None else f"{value:.{digits}f}"


def _finding(kind: str, severity: str, title: str, detail: str, **numbers: Any) -> dict:
    return {"kind": kind, "severity": severity, "title": title, "detail": detail, **numbers}


def build(store: Store, steamid: str, last: int = 0) -> dict:
    summ = stats.summary(store, steamid, last)
    tl = stats.timeline(store, steamid, last)
    maps = stats.breakdown(store, steamid, "map", last)
    weapons = stats.breakdown(store, steamid, "weapon", last)
    economy = stats.breakdown(store, steamid, "economy", last)
    found: list[dict] = []

    found += _data_quality(store, tl)
    if summ["games"] < stats.MIN_GAMES:
        found.append(_finding("sample", "info", "样本不足",
                              f"统计范围内只有 {summ['games']} 场（至少 {stats.MIN_GAMES} 场才做分析），先多导入几场。",
                              value=summ["games"], threshold=stats.MIN_GAMES))
        return _report(steamid, last, summ, found, maps, weapons, economy, tl)

    found += _latest_vs_baseline(tl)
    found += _trends(tl)
    found += _sides(summ["sides"])
    found += _maps(maps)
    found += _openings(summ)
    found += _clutches(summ)
    found += _economy(economy)
    found += _weapons(weapons)
    return _report(steamid, last, summ, found, maps, weapons, economy, tl)


def _report(steamid, last, summ, found, maps, weapons, economy, tl) -> dict:
    order = {"bad": 0, "warn": 1, "good": 2, "info": 3}
    found.sort(key=lambda f: order.get(f["severity"], 9))
    for i, f in enumerate(found):
        f["id"] = f"F{i + 1}"
    keys = ("games", "rounds", "w", "l", "t", "win_rate", "rating", "adr", "kast", "kd", "headshot_pct",
            "opening_kills", "opening_deaths", "clutches_played", "clutches_won", "sample")
    return {
        "engine_version": ENGINE_VERSION,
        "steamid": steamid,
        "scope": {"last": last or None, "games": summ["games"]},
        "summary": {k: summ.get(k) for k in keys},
        "sides": summ.get("sides"),
        "maps": [{k: m[k] for k in ("map_name", "games", "rounds", "w", "l", "rating", "adr", "kast", "sample")}
                 for m in maps],
        "weapons": [{k: w[k] for k in ("weapon", "kills", "shots", "accuracy", "headshot_pct", "sample")}
                    for w in weapons[:6]],
        "economy": [{k: e[k] for k in ("buy_type", "rounds", "round_win_pct", "adr", "sample")} for e in economy],
        "recent": [{k: m[k] for k in ("map_name", "result", "rating", "adr", "kast")} for m in tl[-5:]],
        "findings": found,
    }


def _data_quality(store: Store, tl: list[dict]) -> list[dict]:
    ids = [m["match_id"] for m in tl]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    out = []
    exact = store.query(f"SELECT demo_sha256, COUNT(*) AS n FROM matches WHERE id IN ({marks})"
                        " AND demo_sha256 IS NOT NULL GROUP BY demo_sha256 HAVING n > 1", ids)
    if exact:
        n = sum(r["n"] - 1 for r in exact)
        out.append(_finding("data_quality", "warn", "疑似重复数据",
                            f"有 {n} 场与其他场次的 demo 文件完全相同（SHA-256 一致），会让汇总数字被重复计算。"
                            "建议在 Demo 库里删掉重复的那一场。", value=n))
    # 旧库没有文件指纹：同地图、同比分、同一账号同样的击杀/死亡/ADR → 几乎可以肯定是同一场解析了两次
    seen: dict[tuple, int] = {}
    for m in tl:
        key = (m["map_name"], m["team_score"], m["opp_score"], m["kills"], m["deaths"], round(m["adr"] or 0, 1))
        seen[key] = seen.get(key, 0) + 1
    fuzzy = sum(n - 1 for n in seen.values() if n > 1)
    if fuzzy and not exact:
        out.append(_finding("data_quality", "warn", "疑似重复数据",
                            f"有 {fuzzy} 场与其他场次的地图、比分和个人数据完全一致，可能是同一个 demo 导入了两次。",
                            value=fuzzy))
    return out


def _latest_vs_baseline(tl: list[dict]) -> list[dict]:
    if len(tl) < BASELINE_MIN + 1:
        return []
    latest, history = tl[-1], tl[-1 - BASELINE_WINDOW:-1]
    out = []
    for metric in ("rating", "adr", "kast"):
        values = [m[metric] for m in history if m[metric] is not None]
        if len(values) < BASELINE_MIN or latest[metric] is None:
            continue
        z, med, mad = robust_z(latest[metric], values)
        if z is None or abs(z) < Z_THRESHOLD:
            continue
        good = z > 0
        out.append(_finding(
            "anomaly", "good" if good else "bad",
            f"最近一场 {METRIC_LABEL[metric]} 明显{'高于' if good else '低于'}平时",
            f"{latest['map_name']} 这场 {METRIC_LABEL[metric]} 为 {_f(latest[metric])}，"
            f"之前 {len(values)} 场的中位数是 {_f(med)}（偏离 {abs(z):.1f} 个稳健标准差）。",
            metric=metric, value=latest[metric], baseline=round(med, 3), z=round(z, 2), match_id=latest["match_id"]))
    return out


def _trends(tl: list[dict]) -> list[dict]:
    values = [m["rating"] for m in tl if m["rating"] is not None]
    if len(values) < TREND_RUN + 1:
        return []
    run_down = run_up = 0
    for prev, cur in zip(values[-TREND_RUN - 1:-1], values[-TREND_RUN:]):
        run_down += cur < prev
        run_up += cur > prev
    out = []
    tail = values[-TREND_RUN - 1:]
    if run_down == TREND_RUN:
        out.append(_finding("trend", "bad", f"Rating 连续 {TREND_RUN} 场下滑",
                            f"最近 {TREND_RUN + 1} 场 Rating 依次为 {' → '.join(_f(v) for v in tail)}。",
                            metric="rating", values=tail))
    elif run_up == TREND_RUN:
        out.append(_finding("trend", "good", f"Rating 连续 {TREND_RUN} 场上升",
                            f"最近 {TREND_RUN + 1} 场 Rating 依次为 {' → '.join(_f(v) for v in tail)}。",
                            metric="rating", values=tail))
    if len(values) >= 10:
        recent, older = statistics.median(values[-5:]), statistics.median(values[-10:-5])
        if abs(recent - older) >= 0.1:
            up = recent > older
            out.append(_finding("trend", "good" if up else "warn", f"近期状态{'回升' if up else '回落'}",
                                f"最近 5 场 Rating 中位数 {_f(recent)}，再往前 5 场是 {_f(older)}。",
                                metric="rating", value=round(recent, 3), baseline=round(older, 3)))
    return out


def _sides(sides: dict) -> list[dict]:
    ct, t = sides.get("counter-terrorist"), sides.get("terrorist")
    out = []
    for label, row in (("CT", ct), ("T", t)):
        if row and row["sample"] == "low":
            out.append(_finding("sample", "info", f"{label} 方样本不足",
                                f"{label} 方只有 {row['rounds']} 个回合（至少 {stats.MIN_ROUNDS} 个），暂不评价。",
                                value=row["rounds"]))
    if not ct or not t or ct["sample"] == "low" or t["sample"] == "low":
        return out
    for label, a, b in (("CT", ct, t), ("T", t, ct)):
        if a["adr"] and b["adr"] and a["adr"] >= b["adr"] * 1.15 and a["round_win_pct"] + 5 <= b["round_win_pct"]:
            out.append(_finding(
                "structure", "warn", f"{label} 方打得凶但留不住",
                f"{label} 方 ADR {_f(a['adr'], 1)} 比另一侧高 {100 * (a['adr'] / b['adr'] - 1):.0f}%，"
                f"但回合胜率 {_f(a['round_win_pct'], 1)}% 反而更低（另一侧 {_f(b['round_win_pct'], 1)}%）。"
                "可能是输出集中在已经输掉的局面里，值得回看这些回合的站位与补枪。",
                side=label, adr=a["adr"], other_adr=b["adr"], win_pct=a["round_win_pct"], other_win_pct=b["round_win_pct"]))
    if ct["rating"] is not None and t["rating"] is not None and abs(ct["rating"] - t["rating"]) >= 0.12:
        strong, weak = ("CT", "T") if ct["rating"] > t["rating"] else ("T", "CT")
        out.append(_finding("structure", "info", f"{strong} 方明显强于 {weak} 方",
                            f"CT 方 Rating≈{_f(ct['rating'])}（{ct['rounds']} 回合），"
                            f"T 方 Rating≈{_f(t['rating'])}（{t['rounds']} 回合）。",
                            ct_rating=ct["rating"], t_rating=t["rating"]))
    return out


def _maps(maps: list[dict]) -> list[dict]:
    ok = [m for m in maps if m["sample"] == "ok" and m["rating"] is not None]
    low = [m for m in maps if m["sample"] == "low"]
    out = []
    if len(ok) >= 2:
        best, worst = max(ok, key=lambda m: m["rating"]), min(ok, key=lambda m: m["rating"])
        if best["rating"] - worst["rating"] >= 0.1:
            out.append(_finding("strength", "good", f"最拿手的地图：{best['map_name']}",
                                f"{best['games']} 场 Rating≈{_f(best['rating'])}，{best['w']} 胜 {best['l']} 负。",
                                map_name=best["map_name"], value=best["rating"]))
            out.append(_finding("weakness", "warn", f"最吃力的地图：{worst['map_name']}",
                                f"{worst['games']} 场 Rating≈{_f(worst['rating'])}，{worst['w']} 胜 {worst['l']} 负。",
                                map_name=worst["map_name"], value=worst["rating"]))
    if low:
        out.append(_finding("sample", "info", "部分地图样本不足",
                            "、".join(f"{m['map_name']}（{m['games']} 场）" for m in low) +
                            f" 少于 {stats.MIN_GAMES} 场，不参与地图强弱判断。", maps=[m["map_name"] for m in low]))
    return out


def _openings(s: dict) -> list[dict]:
    attempts = s["opening_kills"] + s["opening_deaths"]
    if attempts < 10:
        return []
    rate = 100.0 * s["opening_kills"] / attempts
    if rate <= 40:
        return [_finding("weakness", "warn", "首杀对枪偏弱",
                         f"参与的 {attempts} 次首杀对枪只赢了 {s['opening_kills']} 次（{rate:.0f}%）。"
                         "如果你常担任突破位，可以多利用道具或让队友先手。", value=round(rate, 1))]
    if rate >= 60:
        return [_finding("strength", "good", "首杀对枪很强",
                         f"参与的 {attempts} 次首杀对枪赢了 {s['opening_kills']} 次（{rate:.0f}%）。",
                         value=round(rate, 1))]
    return []


def _clutches(s: dict) -> list[dict]:
    if s["clutches_played"] < 5:
        return []
    rate = 100.0 * s["clutches_won"] / s["clutches_played"]
    severity = "good" if rate >= 35 else ("warn" if rate <= 15 else "info")
    return [_finding("structure", severity, "残局表现",
                     f"{s['clutches_played']} 次残局赢下 {s['clutches_won']} 次（{rate:.0f}%）。", value=round(rate, 1))]


def _economy(rows: list[dict]) -> list[dict]:
    by = {r["buy_type"]: r for r in rows if r["buy_type"]}
    full, force = by.get("full"), by.get("force")
    if full and force and full["sample"] == "ok" and force["sample"] == "ok":
        if force["round_win_pct"] >= full["round_win_pct"]:
            return [_finding("structure", "info", "强起回合胜率不输长枪局",
                             f"强起回合胜率 {_f(force['round_win_pct'], 1)}%（{force['rounds']} 回合），"
                             f"长枪局 {_f(full['round_win_pct'], 1)}%（{full['rounds']} 回合）。"
                             "长枪局反而没有拉开差距，可以回看全起回合的配合。")]
    return []


def _weapons(rows: list[dict]) -> list[dict]:
    ok = [w for w in rows if w["sample"] == "ok" and w["accuracy"] is not None and w["kills"]]
    if not ok:
        return []
    main = max(ok, key=lambda w: w["kills"])
    return [_finding("info", "info", f"主武器：{main['weapon']}",
                     f"{main['kills']} 杀，命中率 {_f(main['accuracy'], 1)}%，爆头率 {_f(main['headshot_pct'], 1)}%，"
                     f"平均 {_f(main['shots_per_kill'], 1)} 发子弹换一个击杀。",
                     weapon=main["weapon"], kills=main["kills"], accuracy=main["accuracy"])]
