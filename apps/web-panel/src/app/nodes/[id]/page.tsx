"use client";
import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Layout from "@/components/Layout";
import { api, Node, Container, Port, Task, NodeEvent, VersionInfo, NodeMetric, isAgentOutdated } from "@/lib/api";
import { Circle, RefreshCw, Square, Play, CheckCircle, ArrowUpCircle, Loader2, AlertTriangle } from "lucide-react";

type Tab = "overview" | "docker" | "ports" | "tasks" | "events";

function StatusDot({ status }: { status: string }) {
  const color = { online: "text-green-500", offline: "text-red-500", pending: "text-yellow-500" }[status] ?? "text-gray-500";
  return <Circle size={8} className={`${color} fill-current`} />;
}

function MetricBar({ label, used, total, unit }: { label: string; used: number; total: number; unit: string }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  const color = pct > 85 ? "bg-red-500" : pct > 60 ? "bg-yellow-500" : "bg-[#0ea5e9]";
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-[#64748b]">{label}</span>
        <span className="text-white">{used}{unit} / {total}{unit} <span className="text-[#64748b]">({pct}%)</span></span>
      </div>
      <div className="h-1.5 bg-[#0f1117] rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function formatUptime(seconds: number | null) {
  if (!seconds) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)}${units[idx]}`;
}

export default function NodeDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [node, setNode] = useState<Node | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [metrics, setMetrics] = useState<NodeMetric | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<NodeEvent[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [taskLoading, setTaskLoading] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const token = localStorage.getItem("token");
    if (!token) { router.push("/login"); return; }
    try {
      const [n, c, p, m, t, e, vi] = await Promise.all([
        api.nodes.get(id),
        api.nodes.containers(id),
        api.nodes.ports(id),
        api.nodes.metricsLatest(id),
        api.nodes.tasks(id),
        api.nodes.events(id),
        api.version().catch(() => null as VersionInfo | null),
      ]);
      setNode(n); setContainers(c); setPorts(p); setMetrics(m); setTasks(t); setEvents(e);
      if (vi) setVersionInfo(vi);
    } catch {
      router.push("/login");
    }
  }

  useEffect(() => { load(); }, [id]);

  async function handleUpdateAgent() {
    setUpdateLoading(true);
    setUpdateMsg(null);
    try {
      const task = await api.nodes.updateAgent(id);
      setUpdateMsg({ ok: true, text: `Update task created (${task.id.slice(0, 8)}...). Agent will restart shortly.` });
      await load();
    } catch (err: unknown) {
      setUpdateMsg({ ok: false, text: err instanceof Error ? err.message : "Update failed" });
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

  if (!node) return <Layout><div className="p-8 text-[#64748b]">Loading...</div></Layout>;

  const tabs: Tab[] = ["overview", "docker", "ports", "tasks", "events"];
  const runningContainers = containers.filter((c) => c.state === "running").length;
  const openPorts = ports.filter((p) => p.status === "open").length;
  const unexpectedOpenPorts = ports.filter((p) => p.status === "open" && !p.is_expected).length;

  return (
    <Layout>
      <div className="p-8">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <StatusDot status={node.status} />
          <h1 className="text-xl font-bold text-white">{node.name}</h1>
          {node.public_ip && <span className="text-[#64748b] text-sm">{node.public_ip}</span>}
          {node.agent_version && (() => {
            const outdated = isAgentOutdated(node.agent_version, versionInfo?.latest_agent_version ?? null);
            return (
              <span
                className={`inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded ${
                  outdated
                    ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
                    : "bg-[#2a2d3e] text-[#64748b]"
                }`}
                title={outdated ? `Latest: ${versionInfo?.latest_agent_version}` : "Up to date"}
              >
                {outdated && <AlertTriangle size={10} />}
                agent {node.agent_version}
                {outdated && versionInfo?.latest_agent_version && (
                  <span className="text-[#475569]">→ {versionInfo.latest_agent_version}</span>
                )}
              </span>
            );
          })()}
          <span className="text-xs text-[#64748b] ml-auto">
            {node.last_seen_at ? `Last seen: ${new Date(node.last_seen_at).toLocaleString()}` : "Never seen"}
          </span>
          {node.status === "online" && (
            <button
              onClick={handleUpdateAgent}
              disabled={updateLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#0ea5e9]/10 text-[#0ea5e9] hover:bg-[#0ea5e9]/20 border border-[#0ea5e9]/30 transition-colors disabled:opacity-50"
              title="Fetch latest release from GitHub and update agent"
            >
              {updateLoading
                ? <Loader2 size={13} className="animate-spin" />
                : <ArrowUpCircle size={13} />
              }
              Update Agent
            </button>
          )}
        </div>
        {updateMsg && (
          <div className={`mb-4 text-xs px-3 py-2 rounded border ${
            updateMsg.ok
              ? "bg-green-500/10 text-green-400 border-green-500/20"
              : "bg-red-500/10 text-red-400 border-red-500/20"
          }`}>
            {updateMsg.text}
          </div>
        )}

        <div className="flex gap-1 mb-6 border-b border-[#2a2d3e]">
          {tabs.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm capitalize transition-colors border-b-2 -mb-px ${
                tab === t ? "border-[#0ea5e9] text-[#0ea5e9]" : "border-transparent text-[#64748b] hover:text-white"
              }`}>
              {t}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg p-5 space-y-2">
              <h3 className="text-xs font-semibold text-[#64748b] uppercase tracking-wider mb-3">System Info</h3>
              {[
                ["Hostname", node.hostname],
                ["OS", node.os],
                ["Arch", node.arch],
                ["Kernel", node.kernel],
                ["CPU", node.cpu_model],
                ["CPU Cores", node.cpu_cores],
                ["Uptime", formatUptime(node.uptime_seconds)],
                ["Local IPs", node.local_ips?.length ? node.local_ips.join(", ") : null],
                ["Provider", node.provider],
                ["Location", node.location],
                ["Agent Version", node.agent_version],
              ].map(([k, v]) => v ? (
                <div key={k} className="flex justify-between text-sm">
                  <span className="text-[#64748b]">{k}</span>
                  <span className="text-white text-right ml-4 break-all">{v}</span>
                </div>
              ) : null)}
            </div>
            <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg p-5 space-y-4">
              <h3 className="text-xs font-semibold text-[#64748b] uppercase tracking-wider">Live Metrics</h3>
              {metrics ? (
                <>
                  {metrics.cpu_percent != null && (
                    <MetricBar label="CPU" used={Number(metrics.cpu_percent.toFixed(1))} total={100} unit="%" />
                  )}
                  {metrics.ram_used_mb != null && metrics.ram_total_mb != null && (
                    <MetricBar label="RAM" used={metrics.ram_used_mb} total={metrics.ram_total_mb} unit="MB" />
                  )}
                  {metrics.disk_used_gb != null && metrics.disk_total_gb != null && (
                    <MetricBar label="Disk" used={Number(metrics.disk_used_gb.toFixed(1))} total={Number(metrics.disk_total_gb.toFixed(1))} unit="GB" />
                  )}
                  <div className="grid grid-cols-2 gap-3 pt-1 text-xs text-[#64748b]">
                    <div>Load: <span className="text-white">{[metrics.load_1, metrics.load_5, metrics.load_15].filter((v) => v != null).map((v) => v!.toFixed(2)).join(" / ") || "-"}</span></div>
                    <div>Updated: <span className="text-white">{new Date(metrics.created_at).toLocaleTimeString()}</span></div>
                    <div>RX: <span className="text-white">{formatBytes(metrics.network_rx_bytes)}</span></div>
                    <div>TX: <span className="text-white">{formatBytes(metrics.network_tx_bytes)}</span></div>
                  </div>
                </>
              ) : (
                <p className="text-[#64748b] text-sm">No metrics received yet.</p>
              )}
            </div>
            <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg p-5 md:col-span-2">
              <h3 className="text-xs font-semibold text-[#64748b] uppercase tracking-wider mb-3">Inventory Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-[#0f1117] rounded p-3"><div className="text-[#64748b] text-xs">Containers</div><div className="text-white font-semibold">{containers.length}</div></div>
                <div className="bg-[#0f1117] rounded p-3"><div className="text-[#64748b] text-xs">Running</div><div className="text-white font-semibold">{runningContainers}</div></div>
                <div className="bg-[#0f1117] rounded p-3"><div className="text-[#64748b] text-xs">Open Ports</div><div className="text-white font-semibold">{openPorts}</div></div>
                <div className="bg-[#0f1117] rounded p-3"><div className="text-[#64748b] text-xs">Unexpected</div><div className="text-yellow-400 font-semibold">{unexpectedOpenPorts}</div></div>
              </div>
            </div>
          </div>
        )}

        {tab === "docker" && (
          <div className="space-y-2">
            {containers.length === 0 ? (
              <p className="text-[#64748b] text-sm">No containers found.</p>
            ) : (
              <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg divide-y divide-[#2a2d3e]">
                {containers.map((c) => (
                  <div key={c.id} className="flex items-center gap-4 p-4">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Circle size={8} className={`${c.state === "running" ? "text-green-500" : "text-red-500"} fill-current flex-shrink-0`} />
                      <div className="min-w-0">
                        <div className="text-sm text-white font-medium truncate">{c.name}</div>
                        <div className="text-xs text-[#64748b] truncate">{c.image}</div>
                        {c.ports.length > 0 && (
                          <div className="text-[11px] text-[#94a3b8] truncate mt-0.5">{c.ports.join(", ")}</div>
                        )}
                      </div>
                    </div>
                    {c.health_status && (
                      <div className="text-xs text-[#64748b] hidden lg:block">Health: <span className="text-white">{c.health_status}</span></div>
                    )}
                    {c.restart_count != null && (
                      <div className="text-xs text-[#64748b] hidden lg:block">Restarts: <span className="text-white">{c.restart_count}</span></div>
                    )}
                    {c.cpu_percent != null && (
                      <div className="text-xs text-[#64748b] hidden md:block">CPU: <span className="text-white">{c.cpu_percent.toFixed(1)}%</span></div>
                    )}
                    {c.ram_mb != null && (
                      <div className="text-xs text-[#64748b] hidden md:block">RAM: <span className="text-white">{Math.round(c.ram_mb)}MB</span></div>
                    )}
                    <div className="flex gap-1">
                      <button onClick={() => sendTask("container.restart", { container_id: c.container_id })}
                        disabled={taskLoading !== null}
                        className="p-1.5 rounded bg-[#2a2d3e] hover:bg-[#0ea5e9]/20 text-[#64748b] hover:text-[#0ea5e9] transition-colors disabled:opacity-50"
                        title="Restart">
                        <RefreshCw size={13} />
                      </button>
                      <button onClick={() => sendTask("container.stop", { container_id: c.container_id })}
                        disabled={taskLoading !== null}
                        className="p-1.5 rounded bg-[#2a2d3e] hover:bg-red-500/20 text-[#64748b] hover:text-red-400 transition-colors disabled:opacity-50"
                        title="Stop">
                        <Square size={13} />
                      </button>
                      <button onClick={() => sendTask("container.start", { container_id: c.container_id })}
                        disabled={taskLoading !== null}
                        className="p-1.5 rounded bg-[#2a2d3e] hover:bg-green-500/20 text-[#64748b] hover:text-green-400 transition-colors disabled:opacity-50"
                        title="Start">
                        <Play size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "ports" && (
          <div>
            {ports.length === 0 ? (
              <p className="text-[#64748b] text-sm">No open ports found.</p>
            ) : (
              <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#2a2d3e] text-[#64748b] text-xs uppercase">
                      <th className="text-left p-3">Port</th>
                      <th className="text-left p-3">Proto</th>
                      <th className="text-left p-3">Listen IP</th>
                      <th className="text-left p-3">Process</th>
                      <th className="text-left p-3">PID/User</th>
                      <th className="text-left p-3">Container</th>
                      <th className="text-left p-3">State</th>
                      <th className="text-left p-3">Expected</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#2a2d3e]">
                    {ports.map((p) => (
                      <tr key={p.id} className="hover:bg-[#0f1117]/50">
                        <td className="p-3 text-white font-mono">{p.port}</td>
                        <td className="p-3 text-[#64748b]">{p.protocol}</td>
                        <td className="p-3 text-[#64748b] font-mono">{p.listen_ip ?? "0.0.0.0"}</td>
                        <td className="p-3 text-white">{p.process_name ?? "-"}</td>
                        <td className="p-3 text-[#64748b] font-mono">{p.pid ? `${p.pid}${p.user_name ? `/${p.user_name}` : ""}` : "-"}</td>
                        <td className="p-3 text-[#64748b]">{p.container_name ?? "-"}</td>
                        <td className="p-3">
                          <span className={`text-xs px-2 py-0.5 rounded ${p.status === "open" ? "bg-green-500/10 text-green-400" : "bg-[#2a2d3e] text-[#64748b]"}`}>
                            {p.status}
                          </span>
                        </td>
                        <td className="p-3">
                          {p.is_expected ? (
                            <span className="flex items-center gap-1 text-green-400 text-xs"><CheckCircle size={12} />expected</span>
                          ) : (
                            <button onClick={() => api.nodes.markPortExpected(id, p.id, true).then(load)}
                              className="text-yellow-400 text-xs hover:text-yellow-300 underline">mark expected</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "tasks" && (
          <div className="space-y-2">
            {tasks.length === 0 ? (
              <p className="text-[#64748b] text-sm">No tasks yet.</p>
            ) : (
              <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg divide-y divide-[#2a2d3e]">
                {tasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-4 p-4">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                      t.status === "success" ? "bg-green-500/10 text-green-400" :
                      t.status === "failed" ? "bg-red-500/10 text-red-400" :
                      t.status === "running" ? "bg-blue-500/10 text-blue-400" :
                      "bg-[#2a2d3e] text-[#64748b]"
                    }`}>{t.status}</span>
                    <span className="text-sm text-white font-mono">{t.type}</span>
                    <span className="text-xs text-[#64748b] ml-auto">{new Date(t.created_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "events" && (
          <div className="space-y-2">
            {events.length === 0 ? (
              <p className="text-[#64748b] text-sm">No events.</p>
            ) : (
              <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg divide-y divide-[#2a2d3e]">
                {events.map((e) => (
                  <div key={e.id} className="flex items-start gap-3 p-4">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium flex-shrink-0 ${
                      e.severity === "critical" ? "bg-red-500/10 text-red-400" :
                      e.severity === "warning" ? "bg-yellow-500/10 text-yellow-400" :
                      "bg-blue-500/10 text-blue-400"
                    }`}>{e.severity}</span>
                    <div>
                      <div className="text-sm text-white">{e.message}</div>
                      <div className="text-xs text-[#64748b] mt-0.5">{new Date(e.created_at).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
