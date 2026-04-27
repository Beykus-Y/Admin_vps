from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentOperator, DB
from app.db.models import Node, Task
from app.services.inventory import load_inventory_snapshot
from app.services.llm import LLMClientError, call_llm_message, compact_json
from app.services.sub_proxy import SubProxyClientError, request_sub_proxy

router = APIRouter(prefix="/llm", tags=["llm"])
logger = logging.getLogger("uvicorn.error")

LLM_ANALYSIS_TIMEOUT_SECONDS = 180
LLM_MAX_TOOL_ROUNDS = 3
LLM_MAX_TOOL_CALLS_PER_ROUND = 3
LLM_TOOL_TIMEOUT_SECONDS = 45


class LLMAskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    period: str = "7d"
    deep_user_usage: bool = False


def _raise_llm_error(exc: LLMClientError):
    raise HTTPException(status_code=exc.status_code, detail=exc.message)


def _period_params(period: str) -> tuple[dict[str, str], str]:
    now = datetime.now(UTC)
    if period == "current_month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return {"start": start.strftime("%Y-%m-%dT%H:%M:%S"), "end": now.strftime("%Y-%m-%dT%H:%M:%S")}, "current month"
    if period == "previous_month":
        current_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        previous_end = current_start - timedelta(seconds=1)
        previous_start = previous_end.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return {"start": previous_start.strftime("%Y-%m-%dT%H:%M:%S"), "end": previous_end.strftime("%Y-%m-%dT%H:%M:%S")}, "previous month"
    if period == "all":
        return {}, "all time"

    amount = 7
    unit = "d"
    try:
        if period.endswith("h"):
            amount = int(period[:-1] or "24")
            unit = "h"
        elif period.endswith("d"):
            amount = int(period[:-1] or "7")
            unit = "d"
    except ValueError:
        amount = 7
        unit = "d"

    amount = max(1, min(amount, 90 if unit == "d" else 168))
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


async def _deep_node_user_usage(db, users: list[dict], params: dict[str, str], *, sample_limit: int = 40) -> dict:
    candidates = [user for user in users if (user.get("used_traffic") or 0) > 0 and user.get("status") in {"active", "limited"}]
    sample_limit = max(1, min(sample_limit, 100))
    candidates = _top(candidates, lambda item: item.get("used_traffic") or 0, limit=sample_limit)
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
        context["sampled_user_node_usage"] = await _deep_node_user_usage(db, users, params, sample_limit=50)
        context["limitations"].append("Per-node user averages are calculated from top active/limited users by total traffic, capped at 50 users.")
    else:
        context["limitations"].append("Per-node unique-user averages are not calculated unless deep_user_usage=true.")

    return context


def _tool_content(data) -> str:
    value = compact_json(data)
    if len(value) > 24000:
        return value[:24000] + "...[truncated]"
    return value


async def _run_tool_loop(db, *, scope: str, system_prompt: str, user_prompt: str, tools: list[dict], executor) -> tuple[str, str]:
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    model = ""
    started_at = time.perf_counter()
    logger.info("LLM %s analysis started", scope)
    for round_index in range(LLM_MAX_TOOL_ROUNDS):
        logger.info("LLM %s round %s request started", scope, round_index + 1)
        message, model = await call_llm_message(db, messages=messages, tools=tools)
        tool_calls = message.get("tool_calls") or []
        logger.info("LLM %s round %s completed with %s tool call(s)", scope, round_index + 1, len(tool_calls))
        if not tool_calls:
            logger.info("LLM %s analysis finished in %.1fs", scope, time.perf_counter() - started_at)
            return str(message.get("content") or "").strip(), model

        messages.append({
            "role": "assistant",
            "content": message.get("content"),
            "tool_calls": tool_calls,
        })
        for call in tool_calls[:LLM_MAX_TOOL_CALLS_PER_ROUND]:
            function = call.get("function") or {}
            name = function.get("name") or ""
            try:
                arguments = json.loads(function.get("arguments") or "{}")
            except ValueError:
                arguments = {}
            try:
                logger.info("LLM %s tool %s started", scope, name)
                tool_started_at = time.perf_counter()
                result = await asyncio.wait_for(executor(name, arguments), timeout=LLM_TOOL_TIMEOUT_SECONDS)
                logger.info("LLM %s tool %s finished in %.1fs", scope, name, time.perf_counter() - tool_started_at)
            except asyncio.TimeoutError:
                logger.warning("LLM %s tool %s timed out after %ss", scope, name, LLM_TOOL_TIMEOUT_SECONDS)
                result = {"error": f"Tool {name} timed out after {LLM_TOOL_TIMEOUT_SECONDS}s"}
            except Exception as exc:  # noqa: BLE001 - tool errors must be returned to the model
                logger.warning("LLM %s tool %s failed: %s", scope, name, exc)
                result = {"error": str(exc)}
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id"),
                "content": _tool_content(result),
            })
        for call in tool_calls[LLM_MAX_TOOL_CALLS_PER_ROUND:]:
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id"),
                "content": _tool_content({"error": "Skipped: too many tool calls in one round. Ask a narrower question."}),
            })

    messages.append({"role": "user", "content": "Сформируй финальный ответ по уже полученным данным. Если данных недостаточно, так и скажи."})
    logger.info("LLM %s final answer request started after tool limit", scope)
    message, model = await call_llm_message(db, messages=messages)
    logger.info("LLM %s analysis finished after tool limit in %.1fs", scope, time.perf_counter() - started_at)
    return str(message.get("content") or "").strip(), model


async def _resolve_node(db, value: str) -> Node | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        node_id = uuid.UUID(raw)
        result = await db.execute(select(Node).where(Node.id == node_id))
    except ValueError:
        result = await db.execute(select(Node).where((Node.name == raw) | (Node.hostname == raw) | (Node.public_ip == raw)))
    return result.scalar_one_or_none()


async def _run_node_task(db, node: Node, task_type: str, payload: dict, *, timeout_seconds: int = 50) -> dict:
    capabilities = node.capabilities or []
    if capabilities and task_type not in capabilities:
        return {"error": f"Node agent does not support {task_type}. Update agent on this node.", "node": node.name}

    task = Task(node_id=node.id, type=task_type, payload=payload)
    db.add(task)
    await db.commit()
    deadline = datetime.now(UTC) + timedelta(seconds=timeout_seconds)
    while datetime.now(UTC) < deadline:
        await asyncio.sleep(2)
        await db.refresh(task)
        if task.status in {"success", "failed"}:
            return {
                "task_id": str(task.id),
                "node": node.name,
                "status": task.status,
                "result": task.result,
                "error": task.error,
            }
    return {"task_id": str(task.id), "node": node.name, "status": "timeout", "error": "Diagnostic task did not finish in time"}


async def _node_diagnostic_tool(db, name: str, arguments: dict) -> dict:
    node = await _resolve_node(db, str(arguments.get("node") or arguments.get("node_id") or arguments.get("node_name") or ""))
    if not node:
        return {"error": "Node not found", "arguments": arguments}
    if node.status != "online":
        return {"error": "Node is not online", "node": node.name, "status": node.status}

    if name == "get_node_processes":
        return await _run_node_task(db, node, "diagnostics.processes", {"limit": arguments.get("limit") or 25})
    if name == "get_node_disk_usage":
        return await _run_node_task(db, node, "diagnostics.disk_usage", {"path": arguments.get("path") or "/", "limit": arguments.get("limit") or 25})
    if name == "find_node_files":
        return await _run_node_task(db, node, "diagnostics.find_files", {
            "path": arguments.get("path") or "/",
            "pattern": arguments.get("pattern") or "*",
            "min_size_mb": arguments.get("min_size_mb") or 100,
            "limit": arguments.get("limit") or 50,
        })
    return {"error": f"Unknown node diagnostic tool: {name}"}


INFRA_SYSTEM_PROMPT = """
Ты встроенный аналитик FilinControl по VPS-инфраструктуре. Отвечай на русском в Markdown.
У тебя есть read-only tools. Используй их, если для ответа нужны детали по конкретной ноде: процессы, занятое место, крупные файлы.
Не запрашивай диагностику всех нод подряд без необходимости. Не проси и не выполняй destructive-действия.
Диагностические tools не читают содержимое файлов и не выполняют shell, только фиксированные безопасные проверки.
Опирайся только на CONTEXT и результаты tools. Если данных не хватает или агент устарел, скажи это явно.
Рекомендации должны содержать основание: CPU/RAM/Disk/порт/контейнер/событие/результат tool.
""".strip()


VPN_SYSTEM_PROMPT = """
Ты встроенный аналитик FilinControl по VPN/Marzban/MGBoost. Отвечай на русском в Markdown.
У тебя есть read-only tools по VPN: ноды, пользователи, usage, настройки тарификации, billing groups.
Если вопрос про месяц, лимит с 1 числа, перерасход или Яндекс, используй период current_month и учитывай billing_group.
Если у нескольких нод общий billing_group, считай включённый трафик и доп. цену на уровне группы, а не отдельно по каждой ноде.
can_remove=true означает только “можно рассматривать”, а не “удалять”. Перед рекомендацией учитывай роль, заметки, трафик, пользователей, фильтры и дублирование.
Если нужен средний расход на ноде по пользователям, используй tool с breakdown; если выборка ограничена, явно напиши ограничение.
Не выдумывай цены, лимиты, причины и статусы. Если данных нет, сначала попробуй read-only tools, затем напиши, чего не хватает.
""".strip()


INFRA_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_infrastructure_snapshot",
            "description": "Read current FilinControl inventory summary, nodes, metrics, ports, containers and recent events.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_node_processes",
            "description": "Read top CPU processes from one online node using a fixed read-only diagnostic task.",
            "parameters": {
                "type": "object",
                "properties": {"node": {"type": "string"}, "limit": {"type": "integer", "minimum": 5, "maximum": 80}},
                "required": ["node"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_node_disk_usage",
            "description": "Read df and top directory sizes for one online node. Path is restricted to safe roots.",
            "parameters": {
                "type": "object",
                "properties": {"node": {"type": "string"}, "path": {"type": "string"}, "limit": {"type": "integer", "minimum": 5, "maximum": 80}},
                "required": ["node"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_node_files",
            "description": "Find large files or names matching a pattern on one online node. Returns metadata only, not file contents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "node": {"type": "string"},
                    "path": {"type": "string"},
                    "pattern": {"type": "string"},
                    "min_size_mb": {"type": "integer", "minimum": 0, "maximum": 1048576},
                    "limit": {"type": "integer", "minimum": 5, "maximum": 100},
                },
                "required": ["node"],
            },
        },
    },
]


VPN_TOOLS = [
    {"type": "function", "function": {"name": "get_vpn_status", "description": "Read MGBoost/Marzban status, nodes and counts.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}},
    {"type": "function", "function": {"name": "get_vpn_node_settings", "description": "Read MGBoost node billing settings and notes.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}},
    {"type": "function", "function": {"name": "get_vpn_node_usage", "description": "Read Marzban usage by VPN node for a period.", "parameters": {"type": "object", "properties": {"period": {"type": "string"}}, "required": ["period"]}}},
    {"type": "function", "function": {"name": "get_vpn_users", "description": "Read VPN users list summary.", "parameters": {"type": "object", "properties": {"status": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 1000}}}}},
    {"type": "function", "function": {"name": "get_vpn_user_details", "description": "Read one VPN user details and per-node usage for a period.", "parameters": {"type": "object", "properties": {"username": {"type": "string"}, "period": {"type": "string"}}, "required": ["username"]}}},
    {"type": "function", "function": {"name": "get_vpn_node_user_breakdown", "description": "Sample per-user traffic breakdown by node for averages and top users.", "parameters": {"type": "object", "properties": {"node_id": {"type": "integer"}, "node_name": {"type": "string"}, "period": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}}}},
    {"type": "function", "function": {"name": "get_vpn_group_usage", "description": "Calculate usage for a billing group using node_settings.billing_group.", "parameters": {"type": "object", "properties": {"billing_group": {"type": "string"}, "period": {"type": "string"}}, "required": ["billing_group"]}}},
]


async def _execute_infra_tool(db, name: str, arguments: dict) -> dict:
    if name == "get_infrastructure_snapshot":
        return await _infrastructure_context(db)
    return await _node_diagnostic_tool(db, name, arguments)


async def _execute_vpn_tool(db, name: str, arguments: dict) -> dict:
    period = str(arguments.get("period") or "7d")
    params, period_label = _period_params(period)

    if name == "get_vpn_status":
        return await request_sub_proxy("GET", "/status", db=db)
    if name == "get_vpn_node_settings":
        return await request_sub_proxy("GET", "/node-settings", db=db)
    if name == "get_vpn_node_usage":
        result = await request_sub_proxy("GET", "/nodes/usage", db=db, params=params)
        return {"period": {"label": period_label, "params": params}, **result}
    if name == "get_vpn_users":
        limit = int(arguments.get("limit") or 500)
        limit = max(1, min(limit, 1000))
        payload = await request_sub_proxy("GET", "/users", db=db, params={"limit": limit, "offset": 0})
        status_filter = (arguments.get("status") or "").strip()
        if status_filter:
            payload["items"] = [user for user in (payload.get("items") or []) if user.get("status") == status_filter]
            payload["total_filtered"] = len(payload["items"])
        return payload
    if name == "get_vpn_user_details":
        username = str(arguments.get("username") or "").strip()
        if not username:
            return {"error": "username is required"}
        details = await request_sub_proxy("GET", f"/users/{quote(username, safe='')}", db=db, params=params)
        return {"period": {"label": period_label, "params": params}, **details}
    if name == "get_vpn_node_user_breakdown":
        users_payload = await request_sub_proxy("GET", "/users", db=db, params={"limit": 1000, "offset": 0})
        limit = max(1, min(int(arguments.get("limit") or 40), 100))
        breakdown = await _deep_node_user_usage(db, users_payload.get("items") or [], params, sample_limit=limit)
        node_id = arguments.get("node_id")
        node_name = str(arguments.get("node_name") or "").strip().lower()
        if node_id is not None or node_name:
            breakdown["nodes"] = [
                row for row in breakdown.get("nodes", [])
                if (node_id is not None and row.get("node_id") == node_id) or (node_name and str(row.get("node_name") or "").lower() == node_name)
            ]
        return {"period": {"label": period_label, "params": params}, **breakdown}
    if name == "get_vpn_group_usage":
        group = str(arguments.get("billing_group") or "").strip()
        if not group:
            return {"error": "billing_group is required"}
        settings = await request_sub_proxy("GET", "/node-settings", db=db)
        usage = await request_sub_proxy("GET", "/nodes/usage", db=db, params=params)
        usage_rows = usage.get("usages") or []
        group_node_ids = {
            (setting.get("node_id") if setting.get("node_id") is not None else None)
            for setting in settings.values()
            if str(setting.get("billing_group") or "").strip().lower() == group.lower()
        }
        rows = [row for row in usage_rows if row.get("node_id") in group_node_ids]
        total_uplink = sum(row.get("uplink") or 0 for row in rows)
        total_downlink = sum(row.get("downlink") or 0 for row in rows)
        return {
            "period": {"label": period_label, "params": params},
            "billing_group": group,
            "nodes": rows,
            "uplink": total_uplink,
            "downlink": total_downlink,
            "total": total_uplink + total_downlink,
        }
    return {"error": f"Unknown VPN tool: {name}"}


@router.post("/infrastructure")
async def analyze_infrastructure(body: LLMAskRequest, _: CurrentOperator, db: DB):
    context = await _infrastructure_context(db)
    prompt = f"Вопрос администратора: {body.question}\n\nBASE_CONTEXT_INFRASTRUCTURE={compact_json(context)}"
    try:
        answer, model = await asyncio.wait_for(
            _run_tool_loop(
                db,
                scope="infrastructure",
                system_prompt=INFRA_SYSTEM_PROMPT,
                user_prompt=prompt,
                tools=INFRA_TOOLS,
                executor=lambda name, arguments: _execute_infra_tool(db, name, arguments),
            ),
            timeout=LLM_ANALYSIS_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning("LLM infrastructure analysis timed out after %ss", LLM_ANALYSIS_TIMEOUT_SECONDS)
        raise HTTPException(status_code=504, detail="LLM-анализ VPS превысил лимит времени. Попробуйте сузить вопрос или снизить timeout модели.")
    except LLMClientError as exc:
        _raise_llm_error(exc)
    return {"scope": "infrastructure", "model": model, "answer": answer or "LLM завершил анализ, но не вернул текстовый ответ. Попробуйте перефразировать вопрос.", "sources": ["FilinControl inventory", "metrics", "ports", "containers", "events", "alerts", "read-only agent diagnostics"]}


@router.post("/vpn")
async def analyze_vpn(body: LLMAskRequest, _: CurrentOperator, db: DB):
    try:
        context = await _vpn_context(db, period=body.period, deep_user_usage=body.deep_user_usage)
    except SubProxyClientError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    prompt = f"Вопрос администратора: {body.question}\n\nCONTEXT_VPN={compact_json(context)}"
    try:
        answer, model = await asyncio.wait_for(
            _run_tool_loop(
                db,
                scope="vpn",
                system_prompt=VPN_SYSTEM_PROMPT,
                user_prompt=prompt,
                tools=VPN_TOOLS,
                executor=lambda name, arguments: _execute_vpn_tool(db, name, arguments),
            ),
            timeout=LLM_ANALYSIS_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning("LLM VPN analysis timed out after %ss", LLM_ANALYSIS_TIMEOUT_SECONDS)
        raise HTTPException(status_code=504, detail="LLM-анализ VPN превысил лимит времени. Попробуйте сузить вопрос или выключить глубокий анализ пользователей.")
    except LLMClientError as exc:
        _raise_llm_error(exc)
    return {"scope": "vpn", "model": model, "answer": answer or "LLM завершил анализ, но не вернул текстовый ответ. Попробуйте перефразировать вопрос.", "sources": ["Marzban via MGBoost", "MGBoost node settings", "MGBoost device/request metadata", "read-only VPN analytics tools"]}
