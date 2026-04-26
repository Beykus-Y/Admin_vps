from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select

from app.core.config import settings
from app.db.models import AppSetting

SUB_PROXY_SETTING_KEY = "sub_proxy"


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
