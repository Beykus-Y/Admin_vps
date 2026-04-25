"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, ArrowUpCircle, Loader2, Play, Power, RefreshCw, Send, Square, Terminal, Trash2, X } from "lucide-react";
import Layout from "@/components/Layout";
import { api, Container, isAgentOutdated, Node, NodeEvent, NodeMetric, Port, Task, VersionInfo } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatDateTime, formatFullDateTime, formatPercent, formatRelativeTime, formatUptime, statusLabel, taskTypeLabel } from "@/lib/format";
import { isMasterNode } from "@/lib/inventory";
import { type LiveEvent, useLiveReload } from "@/lib/live";
import { Card, DataTable, LineChart, MetricBar, Pill, SectionTitle, SeverityBadge, SoftButton, StatusDot, StatusPill } from "@/components/ui";

type Tab = "overview" | "docker" | "ports" | "tasks" | "events" | "terminal";

const TAB_LABELS: Record<Tab, string> = {
  overview: "Обзор",
  docker: "Контейнеры",
  ports: "Порты",
  tasks: "Задачи",
  events: "События",
  terminal: "SSH",
};

function formatLocalIPs(ips: string[] | null | undefined) {
  if (!ips || ips.length === 0) return null;
  const visible = ips.slice(0, 6);
  const suffix = ips.length > visible.length ? ` +${ips.length - visible.length}` : "";
  return `${visible.join(", ")}${suffix}`;
}

function percent(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used == null || !total) return null;
  return (used / total) * 100;
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="shrink-0 text-[#4a5170]">{label}</span>
      <span className="min-w-0 text-right text-[#dde2f0] break-words">{value}</span>
    </div>
  );
}

function CapabilityList({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0) return <>наследуемая совместимость</>;
  const visible = capabilities.slice(0, 6);
  const hiddenCount = capabilities.length - visible.length;
  return (
    <span className="inline-flex max-w-[620px] flex-wrap justify-end gap-1">
      {visible.map((capability) => (
        <Pill key={capability} color="gray" className="max-w-[210px] truncate" title={capability}>
          {taskTypeLabel(capability)}
        </Pill>
      ))}
      {hiddenCount > 0 && <Pill color="gray">+{hiddenCount}</Pill>}
    </span>
  );
}

function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={active ? "block" : "hidden"}>
      {children}
    </div>
  );
}

function taskStatusColor(status: string): "green" | "red" | "blue" | "yellow" | "gray" {
  if (status === "success") return "green";
  if (status === "failed") return "red";
  if (status === "running") return "blue";
  if (status === "pending") return "yellow";
  return "gray";
}

function terminalStatusColor(status: string): "green" | "red" | "blue" | "yellow" | "gray" {
  if (status === "connected") return "green";
  if (status === "error" || status === "closed") return "red";
  if (status === "waiting" || status === "connecting") return "yellow";
  return "gray";
}

function taskResultText(result: Record<string, unknown> | null): string {
  if (!result) return "-";
  const candidates = [result["message"], result["stdout"], result["output"]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.slice(0, 80);
    }
  }
  return "ok";
}

export default function NodeDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const { user } = useAuth();

  const [node, setNode] = useState<Node | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [metrics, setMetrics] = useState<NodeMetric | null>(null);
  const [history, setHistory] = useState<NodeMetric[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<NodeEvent[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set(["overview"]));
  const [taskLoading, setTaskLoading] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const terminalSocketRef = useRef<WebSocket | null>(null);
  const terminalOutputRef = useRef<HTMLPreElement | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<"idle" | "connecting" | "waiting" | "connected" | "closed" | "error">("idle");
  const [terminalOutput, setTerminalOutput] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalError, setTerminalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }

    try {
      const details = await api.nodes.details(id, "24h", 48);
      setNode(details.node);
      setContainers(details.containers);
      setPorts(details.ports);
      setMetrics(details.metrics);
      setHistory(details.history);
      setTasks(details.tasks);
      setEvents(details.events);
    } catch {
      router.push("/login");
    }
  }, [id, router]);

  const shouldReloadLiveEvent = useCallback((event: LiveEvent) => {
    if (event.type !== "inventory.changed" && event.type !== "tasks.changed") return false;
    const eventNodeId = event.payload?.node_id;
    return typeof eventNodeId !== "string" || eventNodeId === id;
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api.version().then(setVersionInfo).catch(() => null);
  }, []);
  useEffect(() => {
    return () => {
      terminalSocketRef.current?.close();
    };
  }, []);
  useLiveReload(Boolean(node), load, 1200, shouldReloadLiveEvent);

  function selectTab(nextTab: Tab) {
    setTab(nextTab);
    setVisitedTabs((previous) => {
      if (previous.has(nextTab)) return previous;
      const next = new Set(previous);
      next.add(nextTab);
      return next;
    });
  }

  function appendTerminalOutput(value: string) {
    setTerminalOutput((current) => (current + value).slice(-60_000));
    window.setTimeout(() => {
      terminalOutputRef.current?.scrollTo({ top: terminalOutputRef.current.scrollHeight });
    }, 0);
  }

  async function openTerminal() {
    if (terminalSocketRef.current && terminalSocketRef.current.readyState === WebSocket.OPEN) return;
    setTerminalStatus("connecting");
    setTerminalError(null);
    setTerminalOutput("");
    try {
      const session = await api.nodes.createTerminalSession(id);
      const wsUrl = api.terminalWebSocketUrl(session.id);
      if (!wsUrl) throw new Error("Нет токена доступа");
      const socket = new WebSocket(wsUrl);
      terminalSocketRef.current = socket;
      socket.onopen = () => setTerminalStatus("waiting");
      socket.onmessage = (event) => {
        let message: { type: string; status?: typeof terminalStatus; data?: string; message?: string; code?: number };
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "output" && message.data) {
          appendTerminalOutput(message.data);
          return;
        }
        if (message.type === "status") {
          setTerminalStatus(message.status ?? "connected");
          if (message.message) appendTerminalOutput(`\n[${message.message}]\n`);
          return;
        }
        if (message.type === "exit") {
          setTerminalStatus("closed");
          appendTerminalOutput(`\n[${message.message ?? `Shell exited with code ${message.code ?? 0}`}]\n`);
          return;
        }
        if (message.type === "error") {
          setTerminalStatus("error");
          setTerminalError(message.message ?? "Terminal error");
        }
      };
      socket.onerror = () => {
        setTerminalStatus("error");
        setTerminalError("WebSocket connection failed");
      };
      socket.onclose = () => {
        terminalSocketRef.current = null;
        setTerminalStatus((current) => current === "error" ? "error" : "closed");
      };
    } catch (err: unknown) {
      setTerminalStatus("error");
      setTerminalError(err instanceof Error ? err.message : "Не удалось открыть SSH");
    }
  }

  function closeTerminal() {
    const socket = terminalSocketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "close" }));
    }
    socket?.close();
    terminalSocketRef.current = null;
    setTerminalStatus("closed");
  }

  function sendTerminalInput() {
    const value = terminalInput;
    const socket = terminalSocketRef.current;
    if (!value || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "input", data: `${value}\n` }));
    setTerminalInput("");
  }

  function sendTerminalInterrupt() {
    const socket = terminalSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "input", data: "\u0003" }));
  }

  async function handleUpdateAgent() {
    setUpdateLoading(true);
    setUpdateMsg(null);
    try {
      const task = await api.nodes.updateAgent(id);
      setUpdateMsg({ ok: true, text: `Создана задача обновления ${task.id.slice(0, 8)}. Агент перезапустится автоматически.` });
      await load();
    } catch (err: unknown) {
      setUpdateMsg({ ok: false, text: err instanceof Error ? err.message : "Обновление не удалось" });
    } finally {
      setUpdateLoading(false);
    }
  }

  async function sendTask(type: string, payload: Record<string, unknown>) {
    setTaskLoading(type);
    try {
      await api.nodes.createTask(id, type, payload);
      await load();
    } finally {
      setTaskLoading(null);
    }
  }

  async function deleteNode() {
    if (!node) return;
    const confirmed = window.confirm(`Удалить ноду "${node.name}"? Инвентарь, задачи и события будут удалены с мастера.`);
    if (!confirmed) return;
    await api.nodes.delete(id);
    router.push("/nodes");
  }

  if (!node) return <Layout><div className="p-6 font-mono text-sm text-[#4a5170]">Загружаю карточку ноды...</div></Layout>;

  const runningContainers = containers.filter((container) => container.state === "running").length;
  const openPorts = ports.filter((port) => port.status === "open").length;
  const unexpectedOpenPorts = ports.filter((port) => port.status === "open" && !port.is_expected).length;
  const master = isMasterNode(node);
  const outdated = isAgentOutdated(node.agent_version, versionInfo?.latest_agent_version ?? null);
  const ramPct = percent(metrics?.ram_used_mb, metrics?.ram_total_mb);
  const diskPct = percent(metrics?.disk_used_gb, metrics?.disk_total_gb);
  const canOperate = Boolean(user && user.role !== "viewer");
  const canDelete = user?.role === "admin";
  const capabilities = node.capabilities || [];
  const supports = (type: string) => capabilities.length === 0 || capabilities.includes(type);
  const supportsTerminal = capabilities.includes("terminal.session");
  const ramHistory = history.map((point) => (point.ram_used_mb != null && point.ram_total_mb ? (point.ram_used_mb / point.ram_total_mb) * 100 : null));
  const diskHistory = history.map((point) => (point.disk_used_gb != null && point.disk_total_gb ? (point.disk_used_gb / point.disk_total_gb) * 100 : null));

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        <Card className="p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <StatusDot status={node.status} size={10} />
                <h1 className="text-2xl font-bold tracking-[-0.03em] text-[#e8eaf6]">{node.name}</h1>
                {master && <Pill color="purple">МАСТЕР</Pill>}
                <StatusPill status={node.status} />
                {node.agent_version && (
                  <Pill color={outdated ? "yellow" : "gray"}>
                    {outdated && <AlertTriangle size={10} className="mr-1" />}
                    agent {node.agent_version}
                    {outdated && versionInfo?.latest_agent_version && <span className="ml-1 text-[#8f7840]">→ {versionInfo.latest_agent_version}</span>}
                  </Pill>
                )}
              </div>
              <div className="font-mono text-xs leading-6 text-[#4a5170]">
                IP: <span className="text-[#dde2f0]">{node.public_ip || "не определён"}</span> · Host: <span className="text-[#dde2f0]">{node.hostname || "не определён"}</span><br />
                Последний сигнал: <span className="text-[#dde2f0]">{formatRelativeTime(node.last_seen_at)}</span> · Создана: <span className="text-[#dde2f0]">{formatDateTime(node.created_at)}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {canOperate && node.status === "online" && (
                <SoftButton onClick={handleUpdateAgent} disabled={updateLoading} variant={outdated ? "yellow" : "blue"}>
                  {updateLoading ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpCircle size={14} />}
                  Обновить агент
                </SoftButton>
              )}
              {canOperate && node.status === "online" && supports("system.reboot") && (
                <SoftButton onClick={() => sendTask("system.reboot", { delay_minutes: 1 })} disabled={taskLoading !== null} variant="yellow">
                  <Power size={14} />
                  Перезагрузить
                </SoftButton>
              )}
              <SoftButton onClick={() => void load()} variant="ghost"><RefreshCw size={14} /> Обновить</SoftButton>
              {canDelete && <SoftButton onClick={deleteNode} variant="danger"><Trash2 size={14} /> Удалить</SoftButton>}
            </div>
          </div>
          {updateMsg && (
            <div className={`mt-4 rounded-lg border px-3 py-2 font-mono text-xs ${updateMsg.ok ? "border-[#4ade80]/20 bg-[#4ade80]/10 text-[#4ade80]" : "border-[#f87171]/20 bg-[#f87171]/10 text-[#f87171]"}`}>
              {updateMsg.text}
            </div>
          )}
        </Card>

        <div className="flex gap-1 overflow-x-auto border-b border-[#1a1d2e]">
          {(Object.keys(TAB_LABELS) as Tab[]).map((item) => (
            <button
              type="button"
              key={item}
              onClick={() => selectTab(item)}
              aria-selected={tab === item}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-semibold transition ${tab === item ? "border-[#4ade80] text-[#4ade80]" : "border-transparent text-[#5d6684] hover:text-[#dde2f0]"}`}
            >
              {TAB_LABELS[item]}
            </button>
          ))}
        </div>

        {visitedTabs.has("overview") && (
          <TabPanel active={tab === "overview"}>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card className="p-5">
              <SectionTitle>Система</SectionTitle>
              <div className="space-y-3">
                <InfoRow label="Хост" value={node.hostname} />
                <InfoRow label="Публичный IP" value={node.public_ip} />
                <InfoRow label="OS" value={node.os} />
                <InfoRow label="Архитектура" value={node.arch} />
                <InfoRow label="Kernel" value={node.kernel} />
                <InfoRow label="CPU" value={node.cpu_model} />
                <InfoRow label="Ядер CPU" value={node.cpu_cores} />
                <InfoRow label="Аптайм" value={formatUptime(node.uptime_seconds)} />
                <InfoRow label="Локальные IP" value={formatLocalIPs(node.local_ips)} />
                <InfoRow label="Провайдер" value={node.provider} />
                <InfoRow label="Локация" value={node.location} />
                <InfoRow label="Возможности" value={<CapabilityList capabilities={node.capabilities} />} />
              </div>
            </Card>

            <Card className="p-5">
              <SectionTitle>Живые метрики</SectionTitle>
              {metrics ? (
                <div className="space-y-4">
                  <MetricBar label="CPU" value={metrics.cpu_percent} />
                  <MetricBar label="RAM" value={ramPct} />
                  <MetricBar label="Disk" value={diskPct} />
                  <div className="grid gap-3 md:grid-cols-3">
                    <div>
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">CPU 24ч</div>
                      <LineChart values={history.map((point) => point.cpu_percent)} color="#38bdf8" minValue={0} maxValue={100} />
                    </div>
                    <div>
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">RAM 24ч</div>
                      <LineChart values={ramHistory} color="#fbbf24" minValue={0} maxValue={100} />
                    </div>
                    <div>
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">Disk 24ч</div>
                      <LineChart values={diskHistory} color="#a78bfa" minValue={0} maxValue={100} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 pt-2 font-mono text-xs text-[#4a5170]">
                    <div className="rounded-lg bg-[#0c0e16] p-3">Нагрузка: <span className="text-[#dde2f0]">{[metrics.load_1, metrics.load_5, metrics.load_15].filter((value) => value != null).map((value) => value!.toFixed(2)).join(" / ") || "-"}</span></div>
                    <div className="rounded-lg bg-[#0c0e16] p-3">Обновлено: <span className="text-[#dde2f0]">{formatRelativeTime(metrics.created_at)}</span></div>
                    <div className="rounded-lg bg-[#0c0e16] p-3">RX: <span className="text-[#dde2f0]">{formatBytes(metrics.network_rx_bytes)}</span></div>
                    <div className="rounded-lg bg-[#0c0e16] p-3">TX: <span className="text-[#dde2f0]">{formatBytes(metrics.network_tx_bytes)}</span></div>
                  </div>
                </div>
              ) : (
                <div className="font-mono text-sm text-[#4a5170]">Метрики ещё не приходили от агента.</div>
              )}
            </Card>

            <Card className="p-5 xl:col-span-2">
              <SectionTitle>Инвентарь</SectionTitle>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-lg bg-[#0c0e16] p-4"><div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">Контейнеры</div><div className="mt-2 text-2xl font-bold text-[#38bdf8]">{containers.length}</div></div>
                <div className="rounded-lg bg-[#0c0e16] p-4"><div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">Запущено</div><div className="mt-2 text-2xl font-bold text-[#4ade80]">{runningContainers}</div></div>
                <div className="rounded-lg bg-[#0c0e16] p-4"><div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">Открытые порты</div><div className="mt-2 text-2xl font-bold text-[#a78bfa]">{openPorts}</div></div>
                <div className="rounded-lg bg-[#0c0e16] p-4"><div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">Неожиданные</div><div className="mt-2 text-2xl font-bold text-[#fbbf24]">{unexpectedOpenPorts}</div></div>
              </div>
            </Card>
          </div>
          </TabPanel>
        )}

        {visitedTabs.has("docker") && (
          <TabPanel active={tab === "docker"}>
          <DataTable
            rows={containers}
            emptyText="Контейнеры не найдены"
            columns={[
              { key: "name", label: "Контейнер", render: (row) => <div><div className="font-sans text-sm font-semibold text-[#dde2f0]">{row.name}</div><div className="mt-1 max-w-[360px] truncate text-[#4a5170]">{row.image || "образ не указан"}</div></div> },
              { key: "ports", label: "Порты", render: (row) => row.ports.length ? <Pill color="purple">{row.ports.join(", ")}</Pill> : <span className="text-[#2a3355]">нет</span> },
              { key: "cpu", label: "CPU", render: (row) => formatPercent(row.cpu_percent) },
              { key: "ram", label: "RAM", render: (row) => row.ram_mb != null ? `${Math.round(row.ram_mb)} МБ` : "-" },
              { key: "health", label: "Здоровье", render: (row) => row.health_status || <span className="text-[#2a3355]">-</span> },
              { key: "status", label: "Статус", render: (row) => <StatusPill status={row.state || row.status} /> },
              { key: "actions", label: "Действия", render: (row) => (
                <div className="flex gap-1">
                  <button onClick={() => sendTask("container.restart", { container_id: row.container_id })} disabled={!canOperate || taskLoading !== null || !supports("container.restart")} className="rounded bg-[#1d2135] p-1.5 text-[#4a5170] transition hover:text-[#38bdf8] disabled:opacity-40" title="Перезапустить"><RefreshCw size={13} /></button>
                  <button onClick={() => sendTask("container.stop", { container_id: row.container_id })} disabled={!canOperate || taskLoading !== null || !supports("container.stop")} className="rounded bg-[#1d2135] p-1.5 text-[#4a5170] transition hover:text-[#f87171] disabled:opacity-40" title="Остановить"><Square size={13} /></button>
                  <button onClick={() => sendTask("container.start", { container_id: row.container_id })} disabled={!canOperate || taskLoading !== null || !supports("container.start")} className="rounded bg-[#1d2135] p-1.5 text-[#4a5170] transition hover:text-[#4ade80] disabled:opacity-40" title="Запустить"><Play size={13} /></button>
                </div>
              ) },
            ]}
          />
          </TabPanel>
        )}

        {visitedTabs.has("ports") && (
          <TabPanel active={tab === "ports"}>
          <DataTable
            rows={ports}
            emptyText="Открытые порты не найдены"
            columns={[
              { key: "port", label: "Порт", render: (row) => <Pill color="purple">{row.protocol}/{row.port}</Pill> },
              { key: "addr", label: "Адрес", render: (row) => <span className={!row.listen_ip || row.listen_ip === "0.0.0.0" || row.listen_ip === "::" ? "text-[#fbbf24]" : "text-[#4a5170]"}>{row.listen_ip || "0.0.0.0"}</span> },
              { key: "process", label: "Процесс", render: (row) => <span className="text-[#dde2f0]">{row.process_name || "-"}</span> },
              { key: "pid", label: "PID/пользователь", render: (row) => row.pid ? `${row.pid}${row.user_name ? `/${row.user_name}` : ""}` : "-" },
              { key: "container", label: "Контейнер", render: (row) => row.container_name || <span className="text-[#2a3355]">нет</span> },
              { key: "state", label: "Статус", render: (row) => <StatusPill status={row.status} /> },
              { key: "expected", label: "Ожидаемый", render: (row) => row.is_expected ? <Pill color="green">да</Pill> : canOperate ? <button onClick={() => api.nodes.markPortExpected(id, row.id, true).then(() => load())} className="text-[#fbbf24] underline-offset-4 hover:underline">считать ожидаемым</button> : <span className="text-[#2a3355]">нет</span> },
              { key: "seen", label: "Когда", render: (row) => formatDateTime(row.last_seen_at) },
            ]}
          />
          </TabPanel>
        )}

        {visitedTabs.has("tasks") && (
          <TabPanel active={tab === "tasks"}>
          <DataTable
            rows={tasks}
            emptyText="Задач пока нет"
            columns={[
              { key: "status", label: "Статус", render: (row) => <Pill color={taskStatusColor(row.status)}>{statusLabel(row.status)}</Pill> },
              { key: "type", label: "Тип", render: (row) => <span className="text-[#dde2f0]">{taskTypeLabel(row.type)}</span> },
              { key: "result", label: "Результат", render: (row) => row.result ? <span className="text-[#4ade80]">{taskResultText(row.result)}</span> : <span className="text-[#2a3355]">-</span> },
              { key: "error", label: "Ошибка", render: (row) => row.error || <span className="text-[#2a3355]">нет</span> },
              { key: "created", label: "Создана", render: (row) => <span title={formatFullDateTime(row.created_at)}>{formatDateTime(row.created_at)}</span> },
            ]}
          />
          </TabPanel>
        )}

        {visitedTabs.has("events") && (
          <TabPanel active={tab === "events"}>
          <DataTable
            rows={events}
            emptyText="Событий нет"
            columns={[
              { key: "severity", label: "Уровень", render: (row) => <SeverityBadge severity={row.severity} /> },
              { key: "message", label: "Событие", render: (row) => <div><div className="font-sans text-sm text-[#dde2f0]">{row.message}</div><div className="mt-1 text-[#4a5170]">{row.type}</div></div> },
              { key: "created", label: "Когда", render: (row) => <span title={formatFullDateTime(row.created_at)}>{formatRelativeTime(row.created_at)}</span> },
            ]}
          />
          </TabPanel>
        )}

        {visitedTabs.has("terminal") && (
          <TabPanel active={tab === "terminal"}>
            <Card className="overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-[#1a1d2e] px-4 py-3 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-3">
                  <Terminal size={16} className="text-[#4ade80]" />
                  <div>
                    <div className="text-sm font-semibold text-[#dde2f0]">Browser SSH</div>
                    <div className="font-mono text-[10px] text-[#4a5170]">{node.name}</div>
                  </div>
                  <Pill color={terminalStatusColor(terminalStatus)}>{terminalStatus === "idle" ? "не подключено" : terminalStatus}</Pill>
                </div>
                <div className="flex flex-wrap gap-2">
                  {terminalStatus === "connected" && (
                    <SoftButton onClick={sendTerminalInterrupt} variant="yellow">Ctrl+C</SoftButton>
                  )}
                  {terminalSocketRef.current ? (
                    <SoftButton onClick={closeTerminal} variant="danger"><X size={14} /> Закрыть</SoftButton>
                  ) : (
                    <SoftButton onClick={() => void openTerminal()} disabled={!canOperate || node.status !== "online" || !supportsTerminal || terminalStatus === "connecting"} variant="primary">
                      {terminalStatus === "connecting" ? <Loader2 size={14} className="animate-spin" /> : <Terminal size={14} />}
                      Открыть SSH
                    </SoftButton>
                  )}
                </div>
              </div>

              {!canOperate && (
                <div className="border-b border-[#1a1d2e] px-4 py-3 font-mono text-xs text-[#fbbf24]">Нужна роль operator или admin.</div>
              )}
              {canOperate && node.status !== "online" && (
                <div className="border-b border-[#1a1d2e] px-4 py-3 font-mono text-xs text-[#fbbf24]">Нода должна быть online.</div>
              )}
              {canOperate && node.status === "online" && !supportsTerminal && (
                <div className="border-b border-[#1a1d2e] px-4 py-3 font-mono text-xs text-[#fbbf24]">Обнови агент: текущая версия не объявляет terminal.session.</div>
              )}
              {terminalError && (
                <div className="border-b border-[#1a1d2e] px-4 py-3 font-mono text-xs text-[#f87171]">{terminalError}</div>
              )}

              <pre ref={terminalOutputRef} className="h-[420px] overflow-auto bg-[#05070b] p-4 font-mono text-xs leading-5 text-[#d8ffe3]">
                {terminalOutput || "Нажми «Открыть SSH», чтобы создать WebSocket-сессию через агента.\n"}
              </pre>
              <div className="flex gap-2 border-t border-[#1a1d2e] bg-[#080a11] p-3">
                <input
                  value={terminalInput}
                  onChange={(event) => setTerminalInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      sendTerminalInput();
                    }
                  }}
                  disabled={terminalStatus !== "connected"}
                  className="min-w-0 flex-1 rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2 font-mono text-xs text-[#dde2f0] outline-none transition placeholder:text-[#2a3355] focus:border-[#4ade80]/70 disabled:opacity-50"
                  placeholder={terminalStatus === "connected" ? "Введите команду..." : "Ожидание подключения..."}
                />
                <SoftButton onClick={sendTerminalInput} disabled={terminalStatus !== "connected" || !terminalInput} variant="blue">
                  <Send size={14} />
                  Выполнить
                </SoftButton>
              </div>
            </Card>
          </TabPanel>
        )}
      </div>
    </Layout>
  );
}
