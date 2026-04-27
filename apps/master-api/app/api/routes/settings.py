from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import CurrentAdmin, DB
from app.services.app_settings import (
    get_llm_settings_payload,
    get_sub_proxy_settings_payload,
    get_telegram_bot_settings,
    save_llm_settings,
    save_sub_proxy_settings,
    save_telegram_bot_settings,
)
from app.services.audit import log_action
from app.services.llm import LLMClientError, call_llm
from app.services.sub_proxy import SubProxyClientError, request_sub_proxy

router = APIRouter(prefix="/settings", tags=["settings"])


class SubProxyConnectionSettingsUpdate(BaseModel):
    base_url: str = ""
    hmac_secret: str | None = None
    clear_hmac_secret: bool = False
    timeout_seconds: int = Field(default=10, ge=1, le=120)


class LLMSettingsUpdate(BaseModel):
    base_url: str = ""
    api_key: str | None = None
    clear_api_key: bool = False
    model: str = ""
    timeout_seconds: int = Field(default=60, ge=5, le=180)


def _raise_subproxy_error(exc: SubProxyClientError):
    raise HTTPException(status_code=exc.status_code, detail=exc.message)


def _raise_llm_error(exc: LLMClientError):
    raise HTTPException(status_code=exc.status_code, detail=exc.message)


@router.get("/sub-proxy")
async def get_sub_proxy_settings(_: CurrentAdmin, db: DB):
    return await get_sub_proxy_settings_payload(db)


@router.put("/sub-proxy")
async def update_sub_proxy_settings(body: SubProxyConnectionSettingsUpdate, user: CurrentAdmin, db: DB):
    payload = body.model_dump()
    result = await save_sub_proxy_settings(db, payload)
    await log_action(
        db,
        user=user,
        action="settings.sub_proxy.save",
        target_type="settings",
        target_id="sub_proxy",
        message="Sub Proxy connection settings updated",
        details={
            "base_url": result["base_url"],
            "timeout_seconds": result["timeout_seconds"],
            "hmac_secret_set": result["hmac_secret_set"],
        },
    )
    await db.commit()
    return result


@router.post("/sub-proxy/test")
async def test_sub_proxy_settings(_: CurrentAdmin, db: DB):
    try:
        status = await request_sub_proxy("GET", "/status", db=db)
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)
    return {"ok": True, "status": status}


@router.get("/llm")
async def get_llm(_: CurrentAdmin, db: DB):
    return await get_llm_settings_payload(db)


@router.put("/llm")
async def update_llm(body: LLMSettingsUpdate, user: CurrentAdmin, db: DB):
    result = await save_llm_settings(db, body.model_dump())
    await log_action(
        db,
        user=user,
        action="settings.llm.save",
        target_type="settings",
        target_id="llm",
        message="LLM settings updated",
        details={
            "base_url": result["base_url"],
            "model": result["model"],
            "api_key_set": result["api_key_set"],
            "timeout_seconds": result["timeout_seconds"],
        },
    )
    await db.commit()
    return result


@router.post("/llm/test")
async def test_llm_settings(_: CurrentAdmin, db: DB):
    try:
        answer, model = await call_llm(
            db,
            system_prompt="Ответь одним словом: ok",
            user_prompt="Проверка подключения. Ответь: ok",
        )
    except LLMClientError as exc:
        _raise_llm_error(exc)
    return {"ok": True, "model": model, "answer": answer}


class TelegramBotSettingsUpdate(BaseModel):
    runner_node_id: str | None = None
    bot_token: str | None = None
    allowed_chat_ids: list[int] = Field(default_factory=list)


@router.get("/telegram-bot")
async def get_telegram_bot(_: CurrentAdmin, db: DB):
    data = await get_telegram_bot_settings(db)
    return {
        "runner_node_id": data.get("runner_node_id"),
        "bot_token_set": bool(data.get("bot_token")),
        "allowed_chat_ids": data.get("allowed_chat_ids") or [],
    }


@router.put("/telegram-bot")
async def update_telegram_bot(body: TelegramBotSettingsUpdate, user: CurrentAdmin, db: DB):
    result = await save_telegram_bot_settings(db, body.model_dump())
    await log_action(
        db,
        user=user,
        action="settings.telegram_bot.save",
        target_type="settings",
        target_id="telegram_bot",
        message="Telegram bot runner settings updated",
        details={
            "runner_node_id": result["runner_node_id"],
            "bot_token_set": result["bot_token_set"],
            "allowed_chat_ids_count": len(result["allowed_chat_ids"]),
        },
    )
    await db.commit()
    return result
