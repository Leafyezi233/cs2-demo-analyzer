"""分析层共用的小工具：阵营归一、steamid 清洗、tick → 回合归属。

回合归属口径（M0 实测）：用 official_end_tick 而不是 end_tick。end_tick 是回合胜负判定的时刻，
其后到 official_end_tick 之间仍可能发生击杀（end_tick 会漏掉 4 个击杀，official_end_tick 只漏 3 个）。
最后一回合的 official_end_tick 为 null，退回 end_tick。
"""
from __future__ import annotations

from bisect import bisect_right
from typing import Any, Iterable

CT = "counter-terrorist"
T = "terrorist"
SIDES = (CT, T)

_SIDE_ALIASES = {
    "ct": CT, "counter-terrorist": CT, "counterterrorist": CT, "counter_terrorist": CT, "3": CT,
    "t": T, "terrorist": T, "2": T,
}


def norm_side(value: Any) -> str | None:
    """把各种写法的阵营（'CT' / 'ct' / 3 / 'counter-terrorist'）统一成 awpy 的长写法。"""
    if value is None:
        return None
    return _SIDE_ALIASES.get(str(value).strip().lower())


def flip(side: str | None) -> str | None:
    return T if side == CT else (CT if side == T else None)


def clean_sid(value: Any) -> str | None:
    """steamid 统一为字符串；空值与 0（bot / GOTV 录制者）视为无效。"""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in ("0", "None", "null"):
        return None
    return text


def weapon_key(value: Any) -> str:
    """kills 的 weapon 无前缀（ak47），shots 的带 weapon_ 前缀（weapon_ak47），统一去前缀。"""
    return str(value or "").removeprefix("weapon_")


def round_end_tick(row: dict) -> int | None:
    return row.get("official_end_tick") or row.get("end_tick")


class RoundIndex:
    """按 tick 二分查回合号。回合区间 [start_tick, official_end_tick]，区间外返回 None。"""

    def __init__(self, rounds: Iterable[dict]):
        spans = []
        for r in rounds:
            end = round_end_tick(r)
            if r.get("round_num") is None or end is None:
                continue
            start = r.get("start_tick")
            spans.append((int(start if start is not None else 0), int(end), int(r["round_num"])))
        spans.sort()
        self._spans = spans
        self._starts = [s[0] for s in spans]

    def __len__(self) -> int:
        return len(self._spans)

    def round_of(self, tick: Any) -> int | None:
        if tick is None or not self._spans:
            return None
        tick = int(tick)
        i = bisect_right(self._starts, tick) - 1
        if i < 0:
            return None
        start, end, num = self._spans[i]
        return num if start <= tick <= end else None

    def span(self, round_num: int) -> tuple[int, int] | None:
        for start, end, num in self._spans:
            if num == round_num:
                return start, end
        return None
