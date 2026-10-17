"""运行配置：所有路径与环境变量集中在这里，测试可注入临时目录。

环境变量：
- CS2_PANEL_DATA_DIR   数据目录（默认 <项目根>/数据）
- CS2_PANEL_PORT       端口（默认 8765，被占用时向后找）
- CS2_PANEL_NO_BROWSER 设为 1 时启动后不自动开浏览器
- CS2_PANEL_SCAN_DIRS  额外的 demo 扫描目录，用 os.pathsep 分隔
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
LOCAL_MAPDATA = BASE_DIR / "mapdata"
HOST = "127.0.0.1"


@dataclass(frozen=True)
class Config:
    data_dir: Path
    port: int = 8765
    open_browser: bool = True
    extra_scan_dirs: tuple[str, ...] = field(default_factory=tuple)

    @property
    def demo_dir(self) -> Path:
        return self.data_dir / "demos"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "panel.db"

    @property
    def replay_cache(self) -> Path:
        return self.data_dir / "replay_cache"

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / "backups"

    @classmethod
    def from_env(cls) -> "Config":
        data_dir = Path(os.environ.get("CS2_PANEL_DATA_DIR") or (BASE_DIR / "数据"))
        scan = tuple(p for p in os.environ.get("CS2_PANEL_SCAN_DIRS", "").split(os.pathsep) if p)
        return cls(
            data_dir=data_dir,
            port=int(os.environ.get("CS2_PANEL_PORT", "8765")),
            open_browser=os.environ.get("CS2_PANEL_NO_BROWSER") != "1",
            extra_scan_dirs=scan,
        )

    def ensure_dirs(self) -> None:
        for path in (self.data_dir, self.demo_dir, self.replay_cache):
            path.mkdir(parents=True, exist_ok=True)


def setup_mapdata_env() -> str | None:
    """地图资产：优先用包内 mapdata/。必须在 import awpy 之前设置。"""
    if LOCAL_MAPDATA.is_dir():
        os.environ.setdefault("AWPY_DATA_DIR", str(LOCAL_MAPDATA))
        return str(LOCAL_MAPDATA)
    return None
