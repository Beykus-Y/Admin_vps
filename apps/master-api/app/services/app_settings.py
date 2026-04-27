from __future__ import annotations

import uuid as _uuid
from dataclasses import dataclass

from sqlalchemy import select

from app.core.config import settings
from app.db.models import AppSetting, Task

SUB_PROXY_SETTING_KEY = "sub_proxy"
TELEGRAM_BOT_SETTING_KEY = "telegram_bot"
LLM_SETTING_KEY = "llm"


@dataclass
class SubProxyRuntimeSettings:
    base_url: str
    hmac_secret: str
    timeout_seconds: int
    source: str


async def get_setting(db, key: str) -> dict:
    result = await db.execute(select(AppSetting).where(AppSetting.key == key))
    row = result.scalar_one_or_none()
    return dict(row.value or {}) if row else {}


async def set_setting(db, key: str, value: dict) -> AppSetting:
    result = await db.execute(select(AppSetting).where(AppSetting.key == key))
    row = result.scalar_one_or_none()
    if row:
        row.value = value
    else:
        row = AppSetting(key=key, value=value)
        db.add(row)
    await db.flush()
    return row


async def get_sub_proxy_runtime_settings(db) -> SubProxyRuntimeSettings:
    stored = await get_setting(db, SUB_PROXY_SETTING_KEY)
    has_stored_connection = bool(stored.get("base_url") or stored.get("hmac_secret"))
    return SubProxyRuntimeSettings(
        base_url=(stored.get("base_url") or settings.sub_proxy_base_url or "").strip(),
        hmac_secret=(stored.get("hmac_secret") or settings.sub_proxy_hmac_secret or "").strip(),
        timeout_seconds=int(stored.get("timeout_seconds") or settings.sub_proxy_timeout_seconds or 10),
        source="database" if has_stored_connection else "environment",
    )


async def get_sub_proxy_settings_payload(db) -> dict:
    runtime = await get_sub_proxy_runtime_settings(db)
    return {
        "base_url": runtime.base_url,
        "hmac_secret_set": bool(runtime.hmac_secret),
        "timeout_seconds": runtime.timeout_seconds,
        "source": runtime.source,
    }


async def create_bot_notification_task(db, payload: dict) -> None:
    """Create a bot.notify task for the runner node when an alert fires/resolves."""
    bot_setting = await get_setting(db, TELEGRAM_BOT_SETTING_KEY)
    runner_node_id = bot_setting.get("runner_node_id")
    allowed_chat_ids = bot_setting.get("allowed_chat_ids") or []
    if not runner_node_id or not allowed_chat_ids:
        return

    severity = payload.get("severity", "warning")
    status = payload.get("status", "firing")
    title = payload.get("title") or payload.get("message", "")
    node_name = payload.get("node_name")

    icons = {"critical": "🚨", "warning": "⚠️", "info": "ℹ️"}
    icon = icons.get(severity, "⚠️")
    lines = [f"{icon} <b>{title}</b>"]
    if node_name:
        lines.append(f"📍 <b>{node_name}</b>")
    if status == "resolved":
        lines.append("✅ <i>Устранён</i>")

    db.add(Task(
        node_id=_uuid.UUID(runner_node_id),
        type="bot.notify",
        payload={"text": "\n".join(lines), "parse_mode": "HTML", "chat_ids": allowed_chat_ids},
    ))


async def get_telegram_bot_settings(db) -> dict:
    return await get_setting(db, TELEGRAM_BOT_SETTING_KEY)


async def save_telegram_bot_settings(db, payload: dict) -> dict:
    current = await get_setting(db, TELEGRAM_BOT_SETTING_KEY)
    next_value = dict(current)

    if "runner_node_id" in payload:
        next_value["runner_node_id"] = payload.get("runner_node_id") or None
    if "bot_token" in payload and payload["bot_token"] is not None:
        next_value["bot_token"] = str(payload["bot_token"]).strip()
    if "allowed_chat_ids" in payload:
        next_value["allowed_chat_ids"] = [int(x) for x in (payload.get("allowed_chat_ids") or [])]

    await set_setting(db, TELEGRAM_BOT_SETTING_KEY, next_value)
    stored = await get_telegram_bot_settings(db)
    return {
        "runner_node_id": stored.get("runner_node_id"),
        "bot_token_set": bool(stored.get("bot_token")),
        "allowed_chat_ids": stored.get("allowed_chat_ids") or [],
    }


async def save_sub_proxy_settings(db, payload: dict) -> dict:
    current = await get_setting(db, SUB_PROXY_SETTING_KEY)
    next_value = dict(current)

    if "base_url" in payload:
        next_value["base_url"] = (payload.get("base_url") or "").strip()
    if payload.get("hmac_secret"):
        next_value["hmac_secret"] = str(payload["hmac_secret"]).strip()
    if payload.get("clear_hmac_secret"):
        next_value["hmac_secret"] = ""
    if "timeout_seconds" in payload and payload["timeout_seconds"] is not None:
        next_value["timeout_seconds"] = int(payload["timeout_seconds"])

    await set_setting(db, SUB_PROXY_SETTING_KEY, next_value)
    return await get_sub_proxy_settings_payload(db)


async def get_llm_settings(db) -> dict:
    return await get_setting(db, LLM_SETTING_KEY)


async def get_llm_settings_payload(db) -> dict:
    stored = await get_llm_settings(db)
    return {
        "base_url": stored.get("base_url") or "",
        "api_key_set": bool(stored.get("api_key")),
        "model": stored.get("model") or "",
        "timeout_seconds": int(stored.get("timeout_seconds") or 60),
    }


async def save_llm_settings(db, payload: dict) -> dict:
    current = await get_llm_settings(db)
    next_value = dict(current)

    if "base_url" in payload:
        next_value["base_url"] = (payload.get("base_url") or "").strip()
    if "model" in payload:
        next_value["model"] = (payload.get("model") or "").strip()
    if payload.get("api_key"):
        next_value["api_key"] = str(payload["api_key"]).strip()
    if payload.get("clear_api_key"):
        next_value["api_key"] = ""
    if "timeout_seconds" in payload and payload["timeout_seconds"] is not None:
        next_value["timeout_seconds"] = int(payload["timeout_seconds"])

    await set_setting(db, LLM_SETTING_KEY, next_value)
    return await get_llm_settings_payload(db)
