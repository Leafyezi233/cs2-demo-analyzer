"""路由共用的上下文：配置、存储、任务队列、解析函数（测试里可替换成合成数据）。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from fastapi import HTTPException, Request

from ..config import Config
from ..jobs import JobQueue
from ..store import Store


@dataclass
class Context:
    config: Config
    store: Store
    jobs: JobQueue
    parse_fn: Callable[..., dict]

    def setting(self, key: str, default):
        value = self.store.get_setting(key)
        return {**default, **value} if isinstance(default, dict) and isinstance(value, dict) else (value or default)


LIFECYCLE_DEFAULT = {"recycle_days": 30, "scan_dirs": []}


def ctx(request: Request) -> Context:
    return request.app.state.ctx


def require_match(c: Context, match_id: str) -> dict:
    match = c.store.get_match(match_id)
    if not match:
        raise HTTPException(404, "match not found")
    return match
