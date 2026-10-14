"""后台解析任务：线程池 + 内存进度表（单机工具，不需要 Redis/Celery）。"""
from __future__ import annotations

import os
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

TASKS: dict[str, dict] = {}
_LOCK = threading.Lock()
_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="parse")


def _set(task_id: str, **fields: Any) -> None:
    with _LOCK:
        task = TASKS.get(task_id)
        if task is not None:
            task.update(fields)


def get(task_id: str) -> dict | None:
    with _LOCK:
        task = TASKS.get(task_id)
        return dict(task) if task else None


def list_tasks() -> list[dict]:
    with _LOCK:
        return [dict(t) for t in sorted(TASKS.values(), key=lambda x: x["created_at"], reverse=True)]


def submit(file_path: str, file_name: str, worker: Callable[[str, Callable[[str, float], None]], dict]) -> str:
    """提交解析任务，立即返回 task_id。worker(path, progress) -> dict(match_id=..., ...)。"""
    task_id = uuid.uuid4().hex[:16]
    with _LOCK:
        TASKS[task_id] = {
            "id": task_id,
            "file_name": file_name,
            "file_path": file_path,
            "file_size": os.path.getsize(file_path) if os.path.exists(file_path) else None,
            "status": "queued",
            "stage": "排队中",
            "progress": 0.0,
            "match_id": None,
            "error": None,
            "created_at": time.time(),
            "started_at": None,
            "finished_at": None,
            "seconds": None,
        }

    def report(stage: str, progress: float) -> None:
        _set(task_id, stage=stage, progress=round(min(max(progress, 0.0), 1.0), 4))

    def run() -> None:
        t0 = time.time()
        _set(task_id, status="running", started_at=t0, stage="启动解析", progress=0.02)
        try:
            result = worker(file_path, report)
            _set(task_id, status="done", stage="完成", progress=1.0, match_id=result.get("match_id"),
                 finished_at=time.time(), seconds=round(time.time() - t0, 2))
        except Exception as exc:
            _set(task_id, status="failed", stage="失败", error=f"{type(exc).__name__}: {exc}",
                 traceback=traceback.format_exc()[-4000:], finished_at=time.time(),
                 seconds=round(time.time() - t0, 2))

    _POOL.submit(run)
    return task_id
