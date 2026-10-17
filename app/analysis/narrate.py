"""AI 叙述层：把规则引擎的发现清单写成一段中文诊断。

硬约束：数字一个都不让模型自己算。提示词里只给 insights.build() 的结构化结果，
并要求模型只引用其中出现过的数字；模型负责组织语言、归因和训练建议。

provider（设置页可切换，配置存在本机数据库 app_settings 表）：
- none       不调用任何模型，用模板把发现清单拼成文字（离线可用，默认）
- manual     不调用模型，只返回拼好的提示词，用户复制到任意聊天工具
- openai     任何 OpenAI 兼容的 /chat/completions 接口（中转服务、DeepSeek、本地 ollama 等）
- anthropic  Claude（官方 anthropic SDK，可选依赖：pip install anthropic）
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

PROMPT_VERSION = 1
PROVIDERS = ("none", "manual", "openai", "anthropic")
DEFAULTS = {
    "provider": "none",
    "base_url": "",
    "api_key": "",
    "model": "",
    "timeout": 90,
}
DEFAULT_MODELS = {"openai": "deepseek-chat", "anthropic": "claude-opus-5-5"}

SYSTEM_PROMPT = """你是一名 CS2 教练，正在根据一名玩家的数据报告写简短的中文复盘。
规则：
1. 只能使用报告 JSON 里出现过的数字，不要自己计算新的数字，也不要估算。
2. 报告里标为 sample=low 或「样本不足」的维度，只能说明样本不足，不能下结论。
3. 结构固定为三段：「做得好的地方」「需要注意的问题」「接下来练什么」，每段 2~4 条，每条一句话。
4. 训练建议要具体（例如具体地图、阵营、对枪场景），不要空泛的鼓励。
5. 不要输出 Markdown 表格，不要重复整份报告。"""


def public_config(cfg: dict) -> dict:
    """返回给前端的配置：API key 只回显是否已设置，不回显明文。"""
    out = {**DEFAULTS, **(cfg or {})}
    key = out.pop("api_key", "")
    out["api_key_set"] = bool(key)
    out["api_key_hint"] = (key[:3] + "…" + key[-4:]) if len(key) > 10 else ("已设置" if key else "")
    return out


def merge_config(old: dict, new: dict) -> dict:
    cfg = {**DEFAULTS, **(old or {})}
    for key in ("provider", "base_url", "model", "timeout"):
        if key in new and new[key] is not None:
            cfg[key] = new[key]
    if new.get("api_key"):          # 空字符串 = 保持原值；显式 clear_key 才清空
        cfg["api_key"] = str(new["api_key"]).strip()
    if new.get("clear_key"):
        cfg["api_key"] = ""
    if cfg["provider"] not in PROVIDERS:
        raise ValueError(f"未知 provider：{cfg['provider']}")
    cfg["timeout"] = max(5, min(600, int(cfg.get("timeout") or 90)))
    return cfg


def build_prompt(report: dict, player_name: str | None = None) -> str:
    slim = {k: report.get(k) for k in ("scope", "summary", "sides", "maps", "weapons", "economy", "recent", "findings")}
    who = f"玩家：{player_name}\n" if player_name else ""
    return (who + "下面是规则引擎生成的数据报告（JSON），请按要求写复盘：\n\n"
            + json.dumps(slim, ensure_ascii=False, indent=1, default=str))


def offline_narrative(report: dict) -> str:
    """不调用模型时的兜底：按严重程度把发现清单拼成三段文字。"""
    good = [f for f in report["findings"] if f["severity"] == "good"]
    bad = [f for f in report["findings"] if f["severity"] in ("bad", "warn")]
    info = [f for f in report["findings"] if f["severity"] == "info"]
    lines = []
    if good:
        lines.append("做得好的地方：")
        lines += [f"· {f['title']}：{f['detail']}" for f in good]
    if bad:
        lines.append("需要注意的问题：")
        lines += [f"· {f['title']}：{f['detail']}" for f in bad]
    if info:
        lines.append("其他观察：")
        lines += [f"· {f['title']}：{f['detail']}" for f in info]
    if not lines:
        lines.append("统计范围内没有明显的强项或问题，数据比较平稳。")
    return "\n".join(lines)


class NarrateError(RuntimeError):
    pass


def narrate(report: dict, cfg: dict, player_name: str | None = None) -> dict:
    """返回 {provider, model, narrative, prompt, seconds}；调用失败抛 NarrateError。"""
    cfg = {**DEFAULTS, **(cfg or {})}
    provider = cfg["provider"]
    prompt = build_prompt(report, player_name)
    t0 = time.perf_counter()
    if provider == "none":
        text, model = offline_narrative(report), None
    elif provider == "manual":
        text, model = None, None
    elif provider == "openai":
        model = cfg.get("model") or DEFAULT_MODELS["openai"]
        text = _openai_compatible(cfg, model, prompt)
    elif provider == "anthropic":
        model = cfg.get("model") or DEFAULT_MODELS["anthropic"]
        text = _anthropic(cfg, model, prompt)
    else:
        raise NarrateError(f"未知 provider：{provider}")
    return {"provider": provider, "model": model, "narrative": text, "prompt": prompt,
            "system_prompt": SYSTEM_PROMPT, "prompt_version": PROMPT_VERSION,
            "seconds": round(time.perf_counter() - t0, 2)}


def _openai_compatible(cfg: dict, model: str, prompt: str) -> str:
    base = (cfg.get("base_url") or "").rstrip("/")
    if not base:
        raise NarrateError("请先在设置页填写接口地址（例如 https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1）")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
        "temperature": 0.4,
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = "Bearer " + cfg["api_key"]
    req = urllib.request.Request(base + "/chat/completions", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=cfg.get("timeout") or 90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise NarrateError(f"接口返回 HTTP {exc.code}：{detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise NarrateError(f"连接失败：{exc}") from exc
    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise NarrateError(f"接口返回格式无法识别：{str(data)[:300]}") from exc


def _anthropic(cfg: dict, model: str, prompt: str) -> str:
    try:
        import anthropic
    except ImportError as exc:
        raise NarrateError("使用 Claude 需要先安装官方 SDK：pip install anthropic") from exc
    kwargs: dict[str, Any] = {"timeout": float(cfg.get("timeout") or 90)}
    if cfg.get("api_key"):
        kwargs["api_key"] = cfg["api_key"]
    if cfg.get("base_url"):
        kwargs["base_url"] = cfg["base_url"]
    client = anthropic.Anthropic(**kwargs)
    try:
        # 服务端拒答回退：被安全分类器拒绝时由服务端自动换模型重试（只在 Claude 官方 API 上可用）
        response = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.AuthenticationError as exc:
        raise NarrateError("API key 无效") from exc
    except anthropic.RateLimitError as exc:
        raise NarrateError("请求过于频繁，请稍后再试") from exc
    except anthropic.APIStatusError as exc:
        raise NarrateError(f"Claude 接口返回 HTTP {exc.status_code}：{exc.message}") from exc
    except anthropic.APIConnectionError as exc:
        raise NarrateError(f"连接 Claude 失败：{exc}") from exc
    if response.stop_reason == "refusal":
        raise NarrateError("模型拒绝了这次请求")
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    if not text:
        raise NarrateError("模型没有返回文字内容")
    return text
