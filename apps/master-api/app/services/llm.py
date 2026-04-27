from __future__ import annotations

import json

import httpx

from app.services.app_settings import get_llm_settings


class LLMClientError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _chat_completions_url(base_url: str) -> str:
    value = base_url.rstrip("/")
    if value.endswith("/chat/completions"):
        return value
    return f"{value}/chat/completions"


async def call_llm(db, *, system_prompt: str, user_prompt: str) -> tuple[str, str]:
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
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
    }

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(_chat_completions_url(base_url), headers=headers, json=payload)
    except httpx.RequestError as exc:
        raise LLMClientError(502, f"LLM provider is unreachable: {exc}") from exc

    if response.status_code >= 400:
        try:
            data = response.json()
        except ValueError:
            data = {}
        message = data.get("error", {}).get("message") if isinstance(data.get("error"), dict) else None
        raise LLMClientError(502, message or f"LLM provider returned HTTP {response.status_code}")

    try:
        data = response.json()
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise LLMClientError(502, "LLM provider returned invalid chat completion response") from exc

    return str(content).strip(), model


def compact_json(data) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str)
