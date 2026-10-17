"""CS2 数据面板 —— FastAPI 后端（仅绑定 127.0.0.1）。

启动：python -m app.main  （或由 启动.bat / 启动器调用）
"""
from __future__ import annotations

import socket
import threading
from contextlib import asynccontextmanager
import webbrowser
from urllib.parse import urlsplit

from .config import HOST, STATIC_DIR, Config, setup_mapdata_env

setup_mapdata_env()  # 必须在任何 awpy import 之前

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from . import __version__, ingest, parser  # noqa: E402
from .analysis.derive import DERIVE_VERSION  # noqa: E402
from .api import demos, matches, players, system  # noqa: E402
from .api.deps import Context  # noqa: E402
from .jobs import JobQueue  # noqa: E402
from .store import Store  # noqa: E402

LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}


def create_app(config: Config | None = None, parse_fn=None, auto_rederive: bool = True) -> FastAPI:
    config = config or Config.from_env()
    config.ensure_dirs()
    store = Store(config.db_path, config.backup_dir)
    jobs = JobQueue(workers=2)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        jobs.shutdown()

    app = FastAPI(title="CS2 数据面板", version=__version__, lifespan=lifespan)
    app.state.ctx = Context(config=config, store=store, jobs=jobs, parse_fn=parse_fn or parser.parse)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        """只服务本机：Host 头必须是本机地址（挡 DNS rebinding）；写操作的 Origin 必须同源（挡跨站请求）。"""
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].lower()
        if host and host not in LOCAL_HOSTS and host != "testserver":
            return JSONResponse({"detail": "只接受本机访问"}, status_code=403)
        origin = request.headers.get("origin")
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin != "null":
            if (urlsplit(origin).hostname or "").lower() not in LOCAL_HOSTS:
                return JSONResponse({"detail": "拒绝跨站请求"}, status_code=403)
        return await call_next(request)

    for router in (system.router, matches.router, players.router, demos.router):
        app.include_router(router)

    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/")
    def index():
        page = STATIC_DIR / "index.html"
        if not page.exists():
            return JSONResponse({"detail": "前端未就绪"}, status_code=503)
        return FileResponse(str(page), headers={"Cache-Control": "no-cache"})

    if auto_rederive and store.stale_matches(DERIVE_VERSION):
        # 旧库升级或派生口径变化：后台用存档的原始数据补算，不阻塞启动
        jobs.submit("rederive", "升级派生数据", lambda report: ingest.rederive(store, None, report))
    return app


def _pick_port(preferred: int) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 20)]:
        with socket.socket() as sock:
            try:
                sock.bind((HOST, port))
                return port
            except OSError:
                continue
    return preferred


def main() -> None:
    import uvicorn

    config = Config.from_env()
    port = _pick_port(config.port)
    url = f"http://{HOST}:{port}"
    app = create_app(config)
    if config.open_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"CS2 数据面板已启动：{url}", flush=True)
    uvicorn.run(app, host=HOST, port=port, log_level="info")


if __name__ == "__main__":
    main()
