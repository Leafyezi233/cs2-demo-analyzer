"""导入：原始字节流上传、扫描本机录像、解析本机路径、任务进度。"""
from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import ingest
from ..services import scan
from .deps import LIFECYCLE_DEFAULT, Context, ctx

router = APIRouter(prefix="/api")

CS2_MAGIC = b"PBDEMS2\x00"
CSGO_MAGIC = b"HL2DEMO\x00"


def _unique_target(folder: Path, name: str) -> Path:
    """同名文件不覆盖（旧版会覆盖，导致早先那场的回放读到别的 demo）。"""
    target = folder / name
    stem, suffix = os.path.splitext(name)
    n = 2
    while target.exists():
        target = folder / f"{stem} ({n}){suffix}"
        n += 1
    return target


def _check_magic(head: bytes) -> None:
    if head.startswith(CSGO_MAGIC):
        raise HTTPException(400, "这是 CS:GO 旧格式的 demo，只支持 CS2（Source 2）")
    if len(head) >= 8 and not head.startswith(CS2_MAGIC):
        raise HTTPException(400, "文件不是有效的 CS2 demo（文件头不对）")


@router.post("/demos")
async def upload_demo(request: Request, c: Context = Depends(ctx)) -> dict:
    """接收原始字节流上传（不用 multipart，省掉 python-multipart 依赖）。

    文件名从查询参数 name 或请求头 X-File-Name 取；mtime（毫秒）是浏览器读到的文件修改时间，
    用作比赛时间。边收边算 SHA-256，重复文件不落盘、不解析。
    """
    raw_name = request.query_params.get("name") or request.headers.get("x-file-name") or "upload.dem"
    name = os.path.basename(raw_name.replace("\\", "/"))
    if not name.lower().endswith(".dem"):
        raise HTTPException(400, "只接受 .dem 文件")
    incoming = c.config.demo_dir / ".incoming"
    incoming.mkdir(parents=True, exist_ok=True)
    tmp = incoming / f"{uuid.uuid4().hex}.part"
    h = hashlib.sha256()
    written = 0
    head = b""
    try:
        with open(tmp, "wb") as fh:
            async for chunk in request.stream():
                if len(head) < 8:
                    head += chunk[: 8 - len(head)]
                    if len(head) >= 8:
                        _check_magic(head)
                fh.write(chunk)
                h.update(chunk)
                written += len(chunk)
        if written == 0:
            raise HTTPException(400, "上传内容为空")
        _check_magic(head)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise

    sha = h.hexdigest()
    existing = c.store.find_by_sha(sha)
    if existing:
        tmp.unlink(missing_ok=True)
        c.store.log_import("duplicate", file_name=name, sha256=sha, match_id=existing["id"])
        return {"duplicate": True, "match_id": existing["id"], "file_name": existing["file_name"], "size": written}

    target = _unique_target(c.config.demo_dir, name)
    os.replace(tmp, target)
    played_at = None
    try:
        mtime_ms = float(request.query_params.get("mtime") or 0)
        if mtime_ms > 0:
            played_at = mtime_ms / 1000.0
            os.utime(target, (played_at, played_at))
    except (ValueError, OSError):
        played_at = None
    task_id = c.jobs.submit(
        "parse", name,
        lambda report: ingest.import_demo(c.store, str(target), file_name=name, managed=True, played_at=played_at,
                                          sha256=sha, parse_fn=c.parse_fn, report=report))
    return {"task_id": task_id, "file_name": name, "size": written, "duplicate": False}


@router.post("/demos/scan")
def scan_replays(c: Context = Depends(ctx)) -> dict:
    """扫描本机 Steam 库里的 .dem（只登记，不解析），并标出已经导入过的文件。"""
    extra = list(c.config.extra_scan_dirs) + list(c.setting("lifecycle", LIFECYCLE_DEFAULT).get("scan_dirs") or [])
    result = scan.scan(extra)
    known = {os.path.normcase(os.path.abspath(m["file_path"])): m["id"]
             for m in c.store.list_matches() if m.get("file_path")}
    for item in result["found"]:
        item["match_id"] = known.get(os.path.normcase(os.path.abspath(item["path"])))
    return result


@router.post("/demos/local")
def parse_local(path: str = Query(...), force: bool = False, c: Context = Depends(ctx)) -> dict:
    """解析本机已有路径的 demo（不复制文件；指纹与去重在后台任务里做）。"""
    if not os.path.isfile(path):
        raise HTTPException(400, f"文件不存在：{path}")
    if not path.lower().endswith(".dem"):
        raise HTTPException(400, "只接受 .dem 文件")
    with open(path, "rb") as fh:
        _check_magic(fh.read(8))
    name = os.path.basename(path)
    task_id = c.jobs.submit(
        "parse", name,
        lambda report: ingest.import_demo(c.store, path, file_name=name, managed=False, force=force,
                                          parse_fn=c.parse_fn, report=report))
    return {"task_id": task_id, "file_name": name}


@router.get("/tasks")
def all_tasks(c: Context = Depends(ctx)) -> list[dict]:
    return c.jobs.list()


@router.get("/tasks/{task_id}")
def one_task(task_id: str, c: Context = Depends(ctx)) -> dict:
    task = c.jobs.get(task_id)
    if not task:
        raise HTTPException(404, "task not found")
    return task


@router.get("/imports")
def import_log(limit: int = Query(50, ge=1, le=500), c: Context = Depends(ctx)) -> list[dict]:
    return c.store.query("SELECT * FROM import_log ORDER BY id DESC LIMIT ?", (limit,))
