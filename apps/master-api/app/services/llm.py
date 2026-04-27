from __future__ import annotations

import json
import logging
import time

import httpx

from app.services.app_settings import get_llm_settings


class LLMClientError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


logger = logging.getLogger("uvicorn.error")


def _chat_completions_url(base_url: str) -> str:
    value = base_url.rstrip("/")
    if value.endswith("/chat/completions"):
        return value
    return f"{value}/chat/completions"


async def call_llm_message(db, *, messages: list[dict], tools: list[dict] | None = None) -> tuple[dict, str]:
    settings = await get_llm_settings(db)
    base_url = (settings.get("base_url") or "").strip()
    api_key = (settings.get("api_key") or "").strip()
    model = (settings.get("model") or "").strip()
    timeout_seconds = int(settings.get("timeout_seconds") or 60)

    if not base_url or not model:
        raise LLMClientError(503, "LLM is not configured")

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    started_at = time.perf_counter()
    logger.info("LLM provider request started model=%s messages=%s tools=%s timeout=%ss", model, len(messages), bool(tools), timeout_seconds)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(_chat_completions_url(base_url), headers=headers, json=payload)
    except httpx.RequestError as exc:
        logger.warning("LLM provider request failed after %.1fs: %s", time.perf_counter() - started_at, exc)
        raise LLMClientError(502, f"LLM provider is unreachable: {exc}") from exc

    duration = time.perf_counter() - started_at
    logger.info("LLM provider request finished status=%s in %.1fs", response.status_code, duration)

    if response.status_code >= 400:
        try:
            data = response.json()
        except ValueError:
            data = {}
        message = data.get("error", {}).get("message") if isinstance(data.get("error"), dict) else None
        raise LLMClientError(502, message or f"LLM provider returned HTTP {response.status_code}")

    try:
        data = response.json()
        message = data["choices"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise LLMClientError(502, "LLM provider returned invalid chat completion response") from exc

    return message, model


async def call_llm(db, *, system_prompt: str, user_prompt: str) -> tuple[str, str]:
    message, model = await call_llm_message(
        db,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    content = message.get("content") or ""
    return str(content).strip(), model


def compact_json(data) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str)
