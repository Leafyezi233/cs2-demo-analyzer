"""后台任务：线程池 + 内存进度表（单机工具，不需要 Redis/Celery）。

任务表只在内存里，重启即清空；需要长期保留的信息（导入成功/失败、解析记录）由 Store 落库。
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

Report = Callable[[str, float], None]
KEEP_FINISHED = 50


class JobQueue:
    def __init__(self, workers: int = 2):
        self._tasks: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._done = threading.Condition(self._lock)
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="job")

    def _set(self, task_id: str, **fields: Any) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is not None:
                task.update(fields)
                if fields.get("status") in ("done", "failed"):
                    self._done.notify_all()

    def get(self, task_id: str) -> dict | None:
        with self._lock:
            task = self._tasks.get(task_id)
            return dict(task) if task else None

    def list(self) -> list[dict]:
        with self._lock:
            return [dict(t) for t in sorted(self._tasks.values(), key=lambda x: x["created_at"], reverse=True)]

    def active(self, kind: str) -> list[dict]:
        return [t for t in self.list() if t["kind"] == kind and t["status"] in ("queued", "running")]

    def wait(self, task_id: str, timeout: float = 30.0) -> dict | None:
        deadline = time.time() + timeout
        with self._lock:
            while True:
                task = self._tasks.get(task_id)
                if task is None or task["status"] in ("done", "failed"):
                    return dict(task) if task else None
                left = deadline - time.time()
                if left <= 0:
                    return dict(task)
                self._done.wait(left)

    def _prune(self) -> None:
        finished = sorted((t for t in self._tasks.values() if t["status"] in ("done", "failed")),
                          key=lambda t: t["created_at"])
        for task in finished[:-KEEP_FINISHED] if len(finished) > KEEP_FINISHED else []:
            self._tasks.pop(task["id"], None)

    def submit(self, kind: str, label: str, fn: Callable[[Report], dict | None], **meta: Any) -> str:
        """fn(report) -> dict；返回 dict 里的 match_id / duplicate 会提到任务记录顶层，方便前端读。"""
        task_id = uuid.uuid4().hex[:16]
        with self._lock:
            self._prune()
            self._tasks[task_id] = {
                "id": task_id, "kind": kind, "file_name": label, "status": "queued", "stage": "排队中",
                "progress": 0.0, "match_id": None, "duplicate": False, "result": None, "error": None,
                "created_at": time.time(), "started_at": None, "finished_at": None, "seconds": None, **meta,
            }

        def report(stage: str, progress: float) -> None:
            self._set(task_id, stage=stage, progress=round(min(max(progress, 0.0), 1.0), 4))

        def run() -> None:
            t0 = time.time()
            self._set(task_id, status="running", started_at=t0, stage="开始", progress=0.01)
            try:
                result = fn(report) or {}
                self._set(task_id, status="done", stage="完成", progress=1.0, result=result,
                          match_id=result.get("match_id"), duplicate=bool(result.get("duplicate")),
                          finished_at=time.time(), seconds=round(time.time() - t0, 2))
            except Exception as exc:
                self._set(task_id, status="failed", stage="失败", error=f"{type(exc).__name__}: {exc}",
                          traceback=traceback.format_exc()[-4000:], finished_at=time.time(),
                          seconds=round(time.time() - t0, 2))

        self._pool.submit(run)
        return task_id

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
