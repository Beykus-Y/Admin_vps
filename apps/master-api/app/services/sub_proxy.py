from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlencode

import httpx

from app.services.app_settings import get_sub_proxy_runtime_settings


class SubProxyClientError(Exception):
    def __init__(self, status_code: int, message: str, details: dict | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.details = details or {}


def _canonical_json_bytes(payload) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _build_query(params: dict | None) -> str:
    if not params:
        return ""
    pairs: list[tuple[str, str]] = []
    for key, value in params.items():
        if value is None or value == "":
            continue
        if isinstance(value, (list, tuple)):
            for item in value:
                pairs.append((key, str(item)))
        else:
            pairs.append((key, str(value)))
    query = urlencode(pairs)
    return f"?{query}" if query else ""


def _build_signature(method: str, path: str, timestamp: str, nonce: str, body: bytes, secret: str) -> str:
    payload = "\n".join([
        method.upper(),
        path,
        timestamp,
        nonce,
        hashlib.sha256(body).hexdigest(),
    ])
    return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def ensure_sub_proxy_configured(runtime_settings):
    if not runtime_settings.base_url or not runtime_settings.hmac_secret:
        raise SubProxyClientError(503, "Sub Proxy integration is not configured")


async def request_sub_proxy(method: str, path: str, *, db, params: dict | None = None, payload=None):
    runtime_settings = await get_sub_proxy_runtime_settings(db)
    ensure_sub_proxy_configured(runtime_settings)

    request_path = f"/internal/v1{path}{_build_query(params)}"
    body = _canonical_json_bytes(payload) if payload is not None else b""
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(12)

    headers = {
        "X-Filin-Timestamp": timestamp,
        "X-Filin-Nonce": nonce,
        "X-Filin-Signature": _build_signature(method, request_path, timestamp, nonce, body, runtime_settings.hmac_secret),
    }
    if body:
        headers["Content-Type"] = "application/json; charset=utf-8"

    try:
        async with httpx.AsyncClient(
            base_url=runtime_settings.base_url.rstrip("/"),
            timeout=runtime_settings.timeout_seconds,
        ) as client:
            response = await client.request(method.upper(), request_path, headers=headers, content=body)
    except httpx.RequestError as exc:
        raise SubProxyClientError(502, "Sub Proxy is unreachable", {"reason": str(exc)}) from exc

    if response.status_code >= 400:
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        message = payload.get("error") or payload.get("detail") or "Sub Proxy request failed"
        details = payload.get("details") if isinstance(payload.get("details"), dict) else {}
        if response.status_code in {401, 403, 409}:
            raise SubProxyClientError(502, "Sub Proxy authorization failed", {"upstream_status": response.status_code, **details})
        raise SubProxyClientError(response.status_code, message, {"upstream_status": response.status_code, **details})

    if response.status_code == 204 or not response.content:
        return None

    try:
        return response.json()
    except ValueError as exc:
        raise SubProxyClientError(502, "Sub Proxy returned invalid JSON") from exc
