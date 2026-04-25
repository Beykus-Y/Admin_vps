from __future__ import annotations

import asyncio
import json
import smtplib
from email.message import EmailMessage
from typing import Any

import httpx

from app.core.config import settings


async def dispatch_channels(
    channels: list[dict[str, Any]],
    payload: dict[str, Any],
    *,
    test: bool = False,
) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    for channel in channels:
        try:
            await _dispatch_single(channel, payload, test=test)
            results.append({"channel_id": str(channel["id"]), "status": "ok"})
        except Exception as exc:  # pragma: no cover - best-effort delivery
            results.append({"channel_id": str(channel["id"]), "status": "failed", "error": str(exc)})
    return results


async def _dispatch_single(channel: dict[str, Any], payload: dict[str, Any], *, test: bool = False) -> None:
    channel_type = channel["type"]
    if channel_type == "webhook":
        await _send_webhook(channel["config"], payload)
        return
    if channel_type == "telegram":
        await _send_telegram(channel["config"], payload, test=test)
        return
    if channel_type == "email":
        await _send_email(channel["config"], payload, test=test)
        return
    raise ValueError(f"Unsupported channel type '{channel_type}'")


async def _send_webhook(config: dict[str, Any], payload: dict[str, Any]) -> None:
    url = str(config.get("url") or "").strip()
    if not url:
        raise ValueError("Webhook URL is required")
    headers = config.get("headers") or {}
    async with httpx.AsyncClient(timeout=settings.alert_notification_timeout_seconds) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()


async def _send_telegram(config: dict[str, Any], payload: dict[str, Any], *, test: bool = False) -> None:
    bot_token = str(config.get("bot_token") or "").strip()
    chat_id = str(config.get("chat_id") or "").strip()
    if not bot_token or not chat_id:
        raise ValueError("Telegram bot_token and chat_id are required")

    lines = [
        "FilinControl",
        f"Severity: {payload.get('severity', 'info')}",
        f"Status: {payload.get('status', 'open')}",
        payload.get("title") or payload.get("message") or "Alert",
    ]
    if payload.get("node_name"):
        lines.append(f"Node: {payload['node_name']}")
    if test:
        lines.insert(0, "Test notification")

    async with httpx.AsyncClient(timeout=settings.alert_notification_timeout_seconds) as client:
        resp = await client.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": "\n".join(lines)},
        )
        resp.raise_for_status()


async def _send_email(config: dict[str, Any], payload: dict[str, Any], *, test: bool = False) -> None:
    await asyncio.to_thread(_send_email_sync, config, payload, test)


def _send_email_sync(config: dict[str, Any], payload: dict[str, Any], test: bool) -> None:
    host = str(config.get("host") or "").strip()
    port = int(config.get("port") or 465)
    username = str(config.get("username") or "").strip()
    password = str(config.get("password") or "").strip()
    from_email = str(config.get("from_email") or username).strip()
    to_email = str(config.get("to_email") or "").strip()
    use_tls = bool(config.get("use_tls", True))

    if not host or not from_email or not to_email:
        raise ValueError("Email host, from_email and to_email are required")

    msg = EmailMessage()
    subject_prefix = str(config.get("subject_prefix") or "[FilinControl]").strip()
    title = payload.get("title") or payload.get("message") or "Alert"
    if test:
        title = f"Test notification: {title}"
    msg["Subject"] = f"{subject_prefix} {title}"
    msg["From"] = from_email
    msg["To"] = to_email
    msg.set_content(json.dumps(payload, ensure_ascii=False, indent=2, default=str))

    if use_tls:
        with smtplib.SMTP_SSL(host, port, timeout=settings.alert_notification_timeout_seconds) as smtp:
            if username:
                smtp.login(username, password)
            smtp.send_message(msg)
        return

    with smtplib.SMTP(host, port, timeout=settings.alert_notification_timeout_seconds) as smtp:
        smtp.starttls()
        if username:
            smtp.login(username, password)
        smtp.send_message(msg)
