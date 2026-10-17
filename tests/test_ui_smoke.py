"""浏览器冒烟测试：合成数据 + 真实后端 + 无头 Chromium，逐页打开并检查没有 JS 报错。

没有安装 playwright 或浏览器时自动跳过。设置 CS2_UI_SHOTS=<目录> 会顺便保存每页截图。
"""
import json
import os
import socket
import threading
import time
from pathlib import Path

import pytest

playwright_api = pytest.importorskip("playwright.sync_api")

from app.config import Config  # noqa: E402
from app.devtools import synth  # noqa: E402
from app.main import create_app  # noqa: E402
from tools.seed_demo_data import seed  # noqa: E402

HERO = synth.steamid(1)
CHROMIUM = os.environ.get("CS2_UI_CHROMIUM", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
IGNORED = ("Failed to load resource",)   # 地图资产缺失 / 合成 demo 无法解码回放时的 4xx/5xx 属于预期


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    import uvicorn
    data = tmp_path_factory.mktemp("ui") / "data"
    ids = seed(data, matches=10)
    app = create_app(Config(data_dir=data, open_browser=False))
    port = _free_port()
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}", ids
    srv.should_exit = True
    thread.join(timeout=5)


@pytest.fixture(scope="module")
def browser():
    with playwright_api.sync_playwright() as p:
        try:
            kwargs = {"executable_path": CHROMIUM} if Path(CHROMIUM).exists() else {}
            b = p.chromium.launch(**kwargs)
        except Exception as exc:  # 没有可用浏览器
            pytest.skip(f"无法启动 Chromium：{exc}")
        yield b
        b.close()


def open_page(browser, base, identities=True):
    ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
    if identities:
        settings = {"identities": [{"steamid": HERO, "alias": "我"}]}
        ctx.add_init_script(f"localStorage.setItem('cs2panel.settings', {json.dumps(json.dumps(settings))});")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and not any(s in m.text for s in IGNORED) and errors.append(m.text))
    return page, errors


def shot(page, name):
    out = os.environ.get("CS2_UI_SHOTS")
    if out:
        Path(out).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(out) / f"{name}.png"), full_page=True)


def test_home_dashboard(server, browser):
    base, _ids = server
    page, errors = open_page(browser, base)
    page.goto(base + "/")
    page.wait_for_selector("#ag-kpis .kpi", timeout=15000)
    kpis = page.inner_text("#ag-kpis")
    assert "场次" in kpis and "10" in kpis
    page.wait_for_selector("#ag-findings .finding")
    assert page.locator("#tbl-ag-side tbody tr").count() == 2          # CT / T 两行
    assert page.locator("#tbl-ag-map tbody tr").count() >= 3
    assert page.locator("#ag-hl .hl").count() >= 1
    page.click("#btn-report")
    page.wait_for_function("document.querySelector('#report-text').textContent.length > 10")
    page.select_option("#ag-range", "5")
    page.wait_for_function("document.querySelector('#ag-kpis').innerText.includes('▲') || "
                           "document.querySelector('#ag-kpis').innerText.includes('▼') || "
                           "document.querySelector('#ag-kpis').innerText.includes('±0')")
    page.click("[data-mapview=map_side]")
    page.wait_for_function("document.querySelector('#tbl-ag-map thead').innerText.includes('阵营')")
    shot(page, "home")
    assert not errors, errors


def test_library_match_players_map_replay(server, browser):
    base, ids = server
    page, errors = open_page(browser, base)
    page.goto(base + "/#s=library")
    page.wait_for_selector("#tbl-lib tbody tr")
    assert page.locator("#tbl-lib tbody tr").count() == 10
    page.select_option("#lib-demo", "missing")
    assert page.locator("#tbl-lib tbody tr").count() == 0
    page.select_option("#lib-demo", "")
    shot(page, "library")

    page.locator("[data-libopen]").first.click()
    page.wait_for_selector("#match-score .ts")
    assert page.locator("#round-strip .rs").count() >= 13
    assert page.locator("#tbl-rounds tbody tr").count() >= 13
    shot(page, "match")

    page.click("#nav [data-page=players]")
    page.wait_for_selector("#tbl-players tbody tr")
    assert page.locator("#tbl-players tbody tr").count() == 10
    assert "CT Rt" in page.inner_text("#tbl-players thead")
    shot(page, "players")

    page.click("#nav [data-page=map]")
    page.wait_for_function("document.querySelector('#heat-count').textContent.includes('个点')")
    page.select_option("#f-player", HERO)
    page.wait_for_function("document.querySelector('#heat-filter-note').textContent.includes('Alpha')")
    shot(page, "map")

    page.click("#nav [data-page=replay]")
    # 合成 demo 只有几个字节，回放必须给出明确提示而不是白屏/报错
    page.wait_for_function("document.querySelector('#replay-note').textContent.includes('回放不可用')")
    page.wait_for_selector("#killfeed .kf")          # 击杀记录来自数据库，demo 不可用时也要有
    shot(page, "replay")
    assert not errors, errors


def test_highlight_jump_and_compare(server, browser):
    base, ids = server
    page, errors = open_page(browser, base)
    page.goto(base + "/")
    page.wait_for_selector("#ag-hl .hl")
    page.locator("#ag-hl .hl").first.click()
    page.wait_for_function("location.hash.includes('p=replay')")
    assert page.locator("#page-replay").is_visible()

    page.goto(base + "/#s=stats&sel=" + ",".join(ids[:3]))
    page.reload()
    page.wait_for_selector("#tbl-compare tbody tr")
    assert "我" in page.inner_text("#tbl-compare")
    shot(page, "compare")
    assert not errors, errors


def test_settings_and_empty_state(server, browser):
    base, _ids = server
    page, errors = open_page(browser, base, identities=False)
    page.goto(base + "/")
    page.wait_for_selector("#ag-empty:not(.hidden)")
    page.click("#nav [data-page=settings]")
    page.wait_for_selector("#store-kpis .kpi")
    page.wait_for_function("document.querySelectorAll('#id-add option').length >= 10")
    page.click("#btn-id-add")
    page.wait_for_selector("#id-chips .chip")
    page.select_option("#ai-provider", "openai")
    assert page.locator("#ai-base").is_visible()
    page.select_option("#set-theme", "light")
    assert page.evaluate("document.documentElement.dataset.theme") == "light"
    shot(page, "settings")
    page.click("#nav [data-page=home]")
    page.wait_for_selector("#ag-kpis .kpi")
    assert not errors, errors
