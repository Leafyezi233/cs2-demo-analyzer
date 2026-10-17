"""导入流水线：指纹 → 去重 → 解析 → 存原始层 → 派生 → 记录溯源。

与 Web 层解耦：这里的函数只依赖 Store 和一个 parse 函数，测试里可以直接传入合成数据的 parse。
"""
from __future__ import annotations

import hashlib
import os
import time
from typing import Callable

from . import parser
from .analysis import highlights
from .analysis.derive import DERIVE_VERSION, derive_match
from .store import Store

Report = Callable[[str, float], None]
ParseFn = Callable[..., dict]


def _noop(_stage: str, _progress: float) -> None:
    pass


def sha256_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def derive_and_store(store: Store, match_id: str, datasets: dict, tick_rate: float | None,
                     kind: str = "derive") -> dict:
    t0 = time.perf_counter()
    derived = derive_match(datasets)
    hl = highlights.detect(derived, tick_rate)
    store.replace_derived(match_id, derived, hl, DERIVE_VERSION)
    store.record_run(match_id, kind, derive_version=DERIVE_VERSION, seconds=round(time.perf_counter() - t0, 3),
                     row_counts={"player_round": len(derived.player_round), "kills": len(derived.kills),
                                 "highlights": len(hl)},
                     warnings=derived.warnings)
    return {"warnings": derived.warnings, "highlights": len(hl), "teams": derived.teams}


def import_demo(store: Store, file_path: str, *, file_name: str | None = None, managed: bool = False,
                played_at: float | None = None, sha256: str | None = None, force: bool = False,
                parse_fn: ParseFn | None = None, report: Report = _noop) -> dict:
    """导入一份 demo。重复文件（同 SHA-256）直接返回已有场次，除非 force。"""
    parse_fn = parse_fn or parser.parse
    file_name = file_name or os.path.basename(file_path)
    try:
        if sha256 is None:
            report("计算文件指纹", 0.02)
            sha256 = sha256_file(file_path)
        existing = store.find_by_sha(sha256)
        if existing and not force:
            store.log_import("duplicate", file_name=file_name, file_path=file_path, sha256=sha256,
                             match_id=existing["id"])
            return {"match_id": existing["id"], "duplicate": True, "file_name": existing["file_name"]}

        report("解析 demo", 0.05)
        parsed = parse_fn(file_path, progress=report)
        warnings = parser.column_warnings(parsed.get("datasets") or {})
        if played_at is None:
            try:
                played_at = os.path.getmtime(file_path)  # demo 的修改时间≈比赛结束时间，比导入时间更适合排趋势
            except OSError:
                played_at = None
        report("写入数据库", 0.86)
        version = parser.awpy_version()
        match_id = store.save_match(parsed, file_name=file_name, file_path=file_path, sha256=sha256,
                                    played_at=played_at, managed=managed, parser_version=parser.PARSER_VERSION,
                                    awpy_version=version)
        store.record_run(match_id, "parse", parser_version=parser.PARSER_VERSION, awpy_version=version,
                         sha256=sha256, seconds=parsed.get("parse_seconds"),
                         row_counts={k: len(v) for k, v in (parsed.get("datasets") or {}).items()},
                         timings=parsed.get("timings"), dataset_errors=parsed.get("dataset_errors"),
                         warnings=warnings)
        report("计算派生数据", 0.92)
        info = derive_and_store(store, match_id, parsed.get("datasets") or {}, (parsed.get("meta") or {}).get("tick_rate"))
        store.log_import("ok", file_name=file_name, file_path=file_path, sha256=sha256, match_id=match_id)
        return {"match_id": match_id, "duplicate": False, "meta": parsed.get("meta"),
                "warnings": warnings + info["warnings"], "dataset_errors": parsed.get("dataset_errors") or {}}
    except Exception as exc:
        store.log_import("failed", file_name=file_name, file_path=file_path, sha256=sha256,
                         error=f"{type(exc).__name__}: {exc}")
        raise


def reparse_match(store: Store, match_id: str, *, parse_fn: ParseFn | None = None, report: Report = _noop) -> dict:
    """用当前解析器重新解析（需要 demo 本体还在）。"""
    match = store.get_match(match_id)
    if not match:
        raise LookupError("match not found")
    path = match.get("file_path")
    if not path or not os.path.isfile(path):
        raise FileNotFoundError("demo 本体已不在，无法重解析；可以重新导入同一个文件")
    parse_fn = parse_fn or parser.parse
    report("计算文件指纹", 0.02)
    sha = sha256_file(path)
    report("解析 demo", 0.05)
    parsed = parse_fn(path, progress=report)
    version = parser.awpy_version()
    store.replace_raw(match_id, parsed, parser_version=parser.PARSER_VERSION, awpy_version=version, sha256=sha)
    store.record_run(match_id, "reparse", parser_version=parser.PARSER_VERSION, awpy_version=version, sha256=sha,
                     seconds=parsed.get("parse_seconds"),
                     row_counts={k: len(v) for k, v in (parsed.get("datasets") or {}).items()},
                     timings=parsed.get("timings"), dataset_errors=parsed.get("dataset_errors"),
                     warnings=parser.column_warnings(parsed.get("datasets") or {}))
    report("计算派生数据", 0.92)
    derive_and_store(store, match_id, parsed.get("datasets") or {}, (parsed.get("meta") or {}).get("tick_rate"))
    return {"match_id": match_id}


def rederive(store: Store, match_ids: list[str] | None = None, report: Report = _noop) -> dict:
    """用库里存档的原始数据集重算派生层（不需要 demo 本体）。顺手给旧场次补上文件指纹。"""
    ids = match_ids if match_ids is not None else store.stale_matches(DERIVE_VERSION)
    done, failed = 0, {}
    for i, match_id in enumerate(ids):
        report(f"重算派生数据 {i + 1}/{len(ids)}", (i + 0.5) / max(1, len(ids)))
        match = store.get_match(match_id)
        if not match:
            continue
        try:
            derive_and_store(store, match_id, store.get_datasets(match_id), match.get("tick_rate"))
            path = match.get("file_path")
            if not match.get("demo_sha256") and path and os.path.isfile(path):
                store.update_match(match_id, demo_sha256=sha256_file(path))
            done += 1
        except Exception as exc:  # 单场失败不影响其它场
            failed[match_id] = f"{type(exc).__name__}: {exc}"
    return {"done": done, "failed": failed, "total": len(ids)}
