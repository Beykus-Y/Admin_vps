from __future__ import annotations

import asyncio
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import CurrentOperator, DB
from app.services.inventory import load_inventory_snapshot
from app.services.llm import LLMClientError, call_llm, compact_json
from app.services.sub_proxy import SubProxyClientError, request_sub_proxy

router = APIRouter(prefix="/llm", tags=["llm"])


class LLMAskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    period: str = "7d"
    deep_user_usage: bool = False


def _raise_llm_error(exc: LLMClientError):
    raise HTTPException(status_code=exc.status_code, detail=exc.message)


def _period_params(period: str) -> tuple[dict[str, str], str]:
    if period == "all":
        return {}, "all time"

    amount = 7
    unit = "d"
    if period.endswith("h"):
        amount = int(period[:-1] or "24")
        unit = "h"
    elif period.endswith("d"):
        amount = int(period[:-1] or "7")
        unit = "d"

    amount = max(1, min(amount, 90 if unit == "d" else 168))
    now = datetime.now(UTC)
    start = now - (timedelta(days=amount) if unit == "d" else timedelta(hours=amount))
    return {
        "start": start.strftime("%Y-%m-%dT%H:%M:%S"),
        "end": now.strftime("%Y-%m-%dT%H:%M:%S"),
    }, f"last {amount}{unit}"


def _parse_datetime(value) -> datetime | None:
    if not value:
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, UTC)
        raw = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(raw)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    except (TypeError, ValueError):
        return None


def _metric_percent(used, total) -> float | None:
    if used is None or not total:
        return None
    return round(float(used) / float(total) * 100, 1)


def _top(items, key, limit=20):
    return sorted(items, key=key, reverse=True)[:limit]


async def _infrastructure_context(db) -> dict:
    snapshot = await load_inventory_snapshot(db, limit_events=40)
    nodes = []
    for item in snapshot["nodes"]:
        node = item["node"]
        metric = item["metrics"] or {}
        containers = item["containers"]
        ports = item["ports"]
        nodes.append({
            "id": node["id"],
            "name": node["name"],
            "status": node["status"],
            "provider": node.get("provider"),
            "location": node.get("location"),
            "group_name": node.get("group_name"),
            "public_ip": node.get("public_ip"),
            "last_seen_at": node.get("last_seen_at"),
            "agent_version": node.get("agent_version"),
            "tags": node.get("tags") or [],
            "metrics": {
                "cpu_percent": metric.get("cpu_percent"),
                "ram_percent": _metric_percent(metric.get("ram_used_mb"), metric.get("ram_total_mb")),
                "disk_percent": _metric_percent(metric.get("disk_used_gb"), metric.get("disk_total_gb")),
                "load_1": metric.get("load_1"),
                "network_rx_bytes": metric.get("network_rx_bytes"),
                "network_tx_bytes": metric.get("network_tx_bytes"),
                "created_at": metric.get("created_at"),
            },
            "containers": {
                "total": len(containers),
                "running": sum(1 for c in containers if c.get("state") == "running"),
                "restarting_or_unhealthy": [
                    {"name": c.get("name"), "state": c.get("state"), "health_status": c.get("health_status"), "restart_count": c.get("restart_count")}
                    for c in containers
                    if c.get("health_status") not in (None, "healthy") or (c.get("restart_count") or 0) > 0
                ][:20],
            },
            "ports": {
                "open": sum(1 for p in ports if p.get("status") == "open"),
                "unexpected": [
                    {"protocol": p.get("protocol"), "port": p.get("port"), "listen_ip": p.get("listen_ip"), "process": p.get("process_name"), "container": p.get("container_name")}
                    for p in ports
                    if p.get("status") == "open" and not p.get("is_expected")
                ][:30],
            },
            "incidents": item.get("incidents") or [],
            "tasks_pending": item.get("tasks_pending"),
        })

    return {
        "summary": snapshot["summary"],
        "nodes": nodes,
        "recent_events": snapshot["recent_events"],
    }


def _vpn_user_summary(users: list[dict]) -> dict:
    now = datetime.now(UTC)
    status_counts = Counter(user.get("status") or "unknown" for user in users)
    active_recent_24h = 0
    active_recent_7d = 0
    for user in users:
        timestamps = [
            _parse_datetime(user.get("online_at")),
            _parse_datetime((user.get("proxy_last_device") or {}).get("timestamp")),
        ]
        last = max([ts for ts in timestamps if ts], default=None)
        if last and last >= now - timedelta(hours=24):
            active_recent_24h += 1
        if last and last >= now - timedelta(days=7):
            active_recent_7d += 1

    return {
        "total": len(users),
        "status_counts": dict(status_counts),
        "active_recent_24h": active_recent_24h,
        "active_recent_7d": active_recent_7d,
        "top_by_total_used_traffic": [
            {
                "username": user.get("username"),
                "status": user.get("status"),
                "used_traffic": user.get("used_traffic"),
                "data_limit": user.get("data_limit"),
                "online_at": user.get("online_at"),
            }
            for user in _top(users, lambda item: item.get("used_traffic") or 0, limit=25)
        ],
    }


async def _deep_node_user_usage(db, users: list[dict], params: dict[str, str]) -> dict:
    candidates = [user for user in users if (user.get("used_traffic") or 0) > 0 and user.get("status") in {"active", "limited"}]
    candidates = _top(candidates, lambda item: item.get("used_traffic") or 0, limit=100)
    semaphore = asyncio.Semaphore(8)

    async def load_user(username: str):
        async with semaphore:
            try:
                details = await request_sub_proxy("GET", f"/users/{quote(username, safe='')}", db=db, params=params)
            except SubProxyClientError:
                return username, []
            return username, (details.get("usage") or {}).get("usages") or []

    rows = await asyncio.gather(*[load_user(user["username"]) for user in candidates if user.get("username")])
    by_node = defaultdict(lambda: {"used_traffic": 0, "users": set(), "top_users": []})
    for username, usages in rows:
        for usage in usages:
            traffic = usage.get("used_traffic") or 0
            if traffic <= 0:
                continue
            key = str(usage.get("node_id") if usage.get("node_id") is not None else usage.get("node_name"))
            by_node[key]["node_id"] = usage.get("node_id")
            by_node[key]["node_name"] = usage.get("node_name")
            by_node[key]["used_traffic"] += traffic
            by_node[key]["users"].add(username)
            by_node[key]["top_users"].append({"username": username, "used_traffic": traffic})

    result = []
    for item in by_node.values():
        unique_users = len(item["users"])
        result.append({
            "node_id": item.get("node_id"),
            "node_name": item.get("node_name"),
            "used_traffic": item["used_traffic"],
            "unique_users_sampled": unique_users,
            "avg_per_sampled_user": round(item["used_traffic"] / unique_users) if unique_users else 0,
            "top_users": _top(item["top_users"], lambda row: row["used_traffic"], limit=8),
        })

    return {
        "sampled_users": len(candidates),
        "period_query": params,
        "nodes": _top(result, lambda row: row["used_traffic"], limit=30),
    }


async def _vpn_context(db, *, period: str, deep_user_usage: bool) -> dict:
    params, period_label = _period_params(period)
    status = await request_sub_proxy("GET", "/status", db=db)
    users_payload = await request_sub_proxy("GET", "/users", db=db, params={"limit": 1000, "offset": 0})
    node_settings = await request_sub_proxy("GET", "/node-settings", db=db)

    try:
        node_usage = await request_sub_proxy("GET", "/nodes/usage", db=db, params=params)
    except SubProxyClientError as exc:
        node_usage = {"error": exc.message, "usages": []}

    users = users_payload.get("items") or []
    context = {
        "period": {"label": period_label, "params": params},
        "service": {
            "marzban_reachable": status.get("marzban", {}).get("reachable"),
            "counts": status.get("counts"),
        },
        "nodes": status.get("nodes") or [],
        "node_settings": node_settings,
        "node_usage": node_usage,
        "users": _vpn_user_summary(users),
        "limitations": [],
    }

    if deep_user_usage:
        context["sampled_user_node_usage"] = await _deep_node_user_usage(db, users, params)
        context["limitations"].append("Per-node user averages are calculated from top active/limited users by total traffic, capped at 100 users.")
    else:
        context["limitations"].append("Per-node unique-user averages are not calculated unless deep_user_usage=true.")

    return context


SYSTEM_PROMPT = """
Ты встроенный аналитик FilinControl. Отвечай на русском, кратко и по делу.
Используй только факты из CONTEXT. Если данных не хватает, прямо скажи, каких данных нет.
Не выдумывай метрики, цены, причины и состояние сервисов. Не предлагай опасные действия без ручного подтверждения.
Если видишь риск или рекомендацию, объясняй её основание цифрами из CONTEXT.
""".strip()


@router.post("/infrastructure")
async def analyze_infrastructure(body: LLMAskRequest, _: CurrentOperator, db: DB):
    context = await _infrastructure_context(db)
    prompt = f"Вопрос администратора: {body.question}\n\nCONTEXT_INFRASTRUCTURE={compact_json(context)}"
    try:
        answer, model = await call_llm(db, system_prompt=SYSTEM_PROMPT, user_prompt=prompt)
    except LLMClientError as exc:
        _raise_llm_error(exc)
    return {"scope": "infrastructure", "model": model, "answer": answer, "sources": ["FilinControl inventory", "metrics", "ports", "containers", "events", "alerts"]}


@router.post("/vpn")
async def analyze_vpn(body: LLMAskRequest, _: CurrentOperator, db: DB):
    try:
        context = await _vpn_context(db, period=body.period, deep_user_usage=body.deep_user_usage)
    except SubProxyClientError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    prompt = f"Вопрос администратора: {body.question}\n\nCONTEXT_VPN={compact_json(context)}"
    try:
        answer, model = await call_llm(db, system_prompt=SYSTEM_PROMPT, user_prompt=prompt)
    except LLMClientError as exc:
        _raise_llm_error(exc)
    return {"scope": "vpn", "model": model, "answer": answer, "sources": ["Marzban via MGBoost", "MGBoost node settings", "MGBoost device/request metadata"]}
