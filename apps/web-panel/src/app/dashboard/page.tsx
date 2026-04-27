"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bot, CheckCircle, Clock3, Loader2, RadioTower, Send, Server } from "lucide-react";
import Layout from "@/components/Layout";
import { api, Overview } from "@/lib/api";
import { flattenContainers, flattenEvents, flattenPorts, InventoryNode, isMasterNode, loadInventory, primaryNodeIP } from "@/lib/inventory";
import { formatBytes, formatDateTime, formatNumber, formatPercent, formatRelativeTime, statusLabel } from "@/lib/format";
import { Card, MetricBar, Pill, SectionTitle, SeverityBadge, SoftButton, SparkBars, StatCard, StatusDot } from "@/components/ui";
import { useLiveReload } from "@/lib/live";

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ramPercent(item: InventoryNode): number | null {
  const used = item.metrics?.ram_used_mb;
  const total = item.metrics?.ram_total_mb;
  return used != null && total ? (used / total) * 100 : null;
}

function diskPercent(item: InventoryNode): number | null {
  const used = item.metrics?.disk_used_gb;
  const total = item.metrics?.disk_total_gb;
  return used != null && total ? (used / total) * 100 : null;
}

function makeSpark(base: number | null | undefined): number[] {
  const value = base ?? 18;
  return [0.55, 0.75, 0.68, 0.9, 0.82, 1, 0.72, 0.86, 0.94, 0.78, 0.88, 0.96].map((factor) => Math.max(3, Math.round(value * factor)));
}

function nodeLastUpdate(item: InventoryNode): string | null {
  const values = [
    item.metrics?.created_at,
    item.node.last_seen_at,
    ...item.containers.map((container) => container.updated_at),
    ...item.ports.map((port) => port.last_seen_at),
  ]
    .filter(Boolean)
    .map((value) => new Date(value as string).getTime())
    .filter((value) => !Number.isNaN(value));

  if (values.length === 0) return null;
  return new Date(Math.max(...values)).toISOString();
}

function NodeOverviewCard({ item }: { item: InventoryNode }) {
  const node = item.node;
  const ip = primaryNodeIP(node);
  const cpu = item.metrics?.cpu_percent ?? null;
  const ram = ramPercent(item);
  const disk = diskPercent(item);
  const running = item.containers.filter((container) => container.state === "running").length;
  const openPorts = item.ports.filter((port) => port.status === "open").length;
  const unexpected = item.ports.filter((port) => port.status === "open" && !port.is_expected).length;
  const lastUpdate = nodeLastUpdate(item);

  return (
    <Link href={`/nodes/${node.id}`} className="group block">
      <Card className="h-full p-4 transition duration-200 group-hover:-translate-y-0.5 group-hover:border-[#2a3355] group-hover:shadow-[0_22px_70px_rgba(0,0,0,0.28)]">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold text-[#e8eaf6]">{node.name}</div>
              {isMasterNode(node) && <Pill color="purple">МАСТЕР</Pill>}
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-[#2a3355]">{ip ?? "IP не определён"} · {node.location ?? "локация не задана"}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusDot status={node.status} />
            <span className="font-mono text-[10px] text-[#4a5170]">{statusLabel(node.status)}</span>
          </div>
        </div>

        <div className="space-y-2">
          <MetricBar label="CPU" value={cpu} />
          <MetricBar label="RAM" value={ram} />
          <MetricBar label="Disk" value={disk} />
        </div>

        <SparkBars values={makeSpark(cpu)} color={cpu != null && cpu > 80 ? "#f87171" : "#4ade80"} className="mt-4" />

        <div className="mt-4 grid grid-cols-3 border-t border-[#1a1d2e] pt-3 text-center">
          <div>
            <div className="text-lg font-bold leading-none text-[#38bdf8]">{item.containers.length}</div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-[#2a3355]">конт.</div>
          </div>
          <div>
            <div className="text-lg font-bold leading-none text-[#a78bfa]">{openPorts}</div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-[#2a3355]">порты</div>
          </div>
          <div>
            <div className="text-lg font-bold leading-none text-[#fbbf24]">{unexpected}</div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-[#2a3355]">новые</div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[10px] text-[#2a3355]">
          <span>{running} запущено</span>
          <span>{formatRelativeTime(lastUpdate)}</span>
        </div>
      </Card>
    </Link>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [inventory, setInventory] = useState<InventoryNode[]>([]);
  const [error, setError] = useState("");
  const [aiQuestion, setAiQuestion] = useState("Какие VPS требуют внимания и что можно оптимизировать?");
  const [aiAnswer, setAiAnswer] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");

  const load = useCallback(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return Promise.resolve();
    }

    return Promise.all([api.overview(), loadInventory()])
      .then(([overviewData, inventoryData]) => {
        setOverview(overviewData);
        setInventory(inventoryData);
        setError("");
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Не удалось загрузить обзор";
        if (message.includes("401")) router.push("/login");
        else setError(message);
      });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveReload(Boolean(overview), load);

  async function askInfrastructureAI() {
    const question = aiQuestion.trim();
    if (!question) return;
    setAiLoading(true);
    setAiError("");
    try {
      const result = await api.llm.infrastructure({ question });
      setAiAnswer(result.answer);
    } catch (err: unknown) {
      setAiError(err instanceof Error ? err.message : "LLM-анализ инфраструктуры не удался");
    } finally {
      setAiLoading(false);
    }
  }

  if (error) return <Layout><div className="p-6 text-[#f87171]">{error}</div></Layout>;
  if (!overview) return <Layout><div className="p-6 font-mono text-sm text-[#4a5170]">Загружаю обзор инфраструктуры...</div></Layout>;

  const containers = flattenContainers(inventory);
  const ports = flattenPorts(inventory);
  const inventoryEvents = flattenEvents(inventory);
  const nodeById = new Map(inventory.map((item) => [item.node.id, item.node.name]));
  const events = (overview.recent_events.length ? overview.recent_events : inventoryEvents).map((event) => ({
    ...event,
    node_name: event.node_id ? nodeById.get(event.node_id) ?? "системное событие" : "системное событие",
  })).slice(0, 12);

  const running = containers.filter((container) => container.state === "running").length;
  const stopped = containers.length - running;
  const openPorts = ports.filter((port) => port.status === "open").length;
  const unexpectedPorts = ports.filter((port) => port.status === "open" && !port.is_expected).length;
  const publicPorts = ports.filter((port) => port.status === "open" && (!port.listen_ip || port.listen_ip === "0.0.0.0" || port.listen_ip === "::")).length;
  const criticalEvent = events.find((event) => event.severity === "critical");
  const warningCount = events.filter((event) => event.severity === "warning" || event.severity === "critical").length;
  const avgCpu = average(inventory.map((item) => item.metrics?.cpu_percent).filter((value): value is number => value != null));
  const avgRam = average(inventory.map(ramPercent).filter((value): value is number => value != null));
  const avgDisk = average(inventory.map(diskPercent).filter((value): value is number => value != null));
  const networkTotal = inventory.reduce((sum, item) => sum + (item.metrics?.network_rx_bytes ?? 0) + (item.metrics?.network_tx_bytes ?? 0), 0);
  const lastUpdateValues = inventory
    .map(nodeLastUpdate)
    .filter(Boolean)
    .map((value) => new Date(value as string).getTime())
    .filter((value) => !Number.isNaN(value));
  const lastUpdate = lastUpdateValues.length ? new Date(Math.max(...lastUpdateValues)).toISOString() : null;
  const hotNodes = inventory.filter((item) => (item.metrics?.cpu_percent ?? 0) >= 80 || (ramPercent(item) ?? 0) >= 80);

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        {criticalEvent ? (
          <Card className="flex flex-col gap-3 border-[#f87171]/20 bg-[#f87171]/[0.07] p-4 sm:flex-row sm:items-center">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f87171]/10 text-[#f87171]">
              <AlertTriangle size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-xs text-[#f87171]">{criticalEvent.message}</div>
              <div className="mt-1 font-mono text-[10px] text-[#7f4a54]">{criticalEvent.node_name} · {formatRelativeTime(criticalEvent.created_at)}</div>
            </div>
            {criticalEvent.node_id && (
              <Link href={`/nodes/${criticalEvent.node_id}`} className="rounded-lg border border-[#f87171]/20 bg-[#f87171]/10 px-3 py-2 text-center text-sm font-semibold text-[#f87171] transition hover:bg-[#f87171]/15">
                Разобраться
              </Link>
            )}
          </Card>
        ) : (
          <Card className="flex items-center gap-3 border-[#4ade80]/15 bg-[#4ade80]/[0.04] p-4">
            <CheckCircle size={18} className="text-[#4ade80]" />
            <div className="font-mono text-xs text-[#4ade80]">Критических событий нет, инфраструктура наблюдается штатно.</div>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="Ноды" value={formatNumber(overview.nodes.total)} sub={`${overview.nodes.online} онлайн · ${overview.nodes.offline} оффлайн`} color="#818cf8" />
          <StatCard label="Контейнеры" value={formatNumber(overview.containers.total || containers.length)} sub={`${running} запущено · ${stopped} стоп`} color="#38bdf8" />
          <StatCard label="Открытые порты" value={formatNumber(overview.ports.total || openPorts)} sub={`${unexpectedPorts} неожиданных · ${publicPorts} публичных`} color="#fbbf24" />
          <StatCard label="Алерты" value={formatNumber(warningCount)} sub={warningCount ? "нужна проверка" : "всё чисто"} color={warningCount ? "#f87171" : "#4ade80"} />
          <StatCard label="Обновлено" value={lastUpdate ? formatRelativeTime(lastUpdate).replace(" назад", "") : "-"} sub={formatDateTime(lastUpdate)} color="#4ade80" />
        </div>

        <div>
          <SectionTitle>LLM-анализ VPS</SectionTitle>
          <Card className="p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#1d2135] bg-[#10131d] text-[#a78bfa]">
                <Bot size={18} />
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <textarea
                  value={aiQuestion}
                  onChange={(event) => setAiQuestion(event.target.value)}
                  className="min-h-[84px] w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2.5 text-sm text-[#dde2f0] outline-none transition placeholder:text-[#2a3355] focus:border-[#a78bfa]/70"
                  placeholder="Спроси про VPS: какие перегружены, что можно убрать, где риск по портам..."
                />
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <SoftButton onClick={askInfrastructureAI} disabled={aiLoading} variant="primary">
                    {aiLoading ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                    Спросить по VPS
                  </SoftButton>
                  <div className="font-mono text-[10px] text-[#2a3355]">Контекст: ноды, метрики, контейнеры, порты, алерты, события.</div>
                </div>
                {aiError && <div className="rounded-lg border border-[#f87171]/20 bg-[#f87171]/[0.07] p-3 font-mono text-xs text-[#f87171]">{aiError}</div>}
                {aiAnswer && <div className="whitespace-pre-wrap rounded-lg border border-[#1a1d2e] bg-[#10131d] p-4 text-sm leading-6 text-[#dde2f0]">{aiAnswer}</div>}
              </div>
            </div>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
          <div>
            <SectionTitle>Ноды и нагрузка</SectionTitle>
            {inventory.length === 0 ? (
              <Card className="p-8 text-center font-mono text-sm text-[#4a5170]">Нод пока нет. Добавьте первый VPS в разделе нод.</Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {inventory.map((item) => <NodeOverviewCard key={item.node.id} item={item} />)}
              </div>
            )}
          </div>

          <div className="space-y-5">
            <div>
              <SectionTitle>Что происходит</SectionTitle>
              <Card className="max-h-[430px] overflow-y-auto">
                {events.length === 0 ? (
                  <div className="p-8 text-center font-mono text-xs text-[#2a3355]">Событий пока нет</div>
                ) : events.map((event) => (
                  <div key={event.id} className="flex gap-3 border-b border-[#0f1218] px-4 py-3 transition hover:bg-[#141722]">
                    <SeverityBadge severity={event.severity} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs text-[#8892b0]">{event.message}</div>
                      <div className="mt-1 font-mono text-[10px] text-[#2a3355]">{event.node_name} · {formatRelativeTime(event.created_at)}</div>
                    </div>
                  </div>
                ))}
              </Card>
            </div>

            <div>
              <SectionTitle>Срез ресурсов</SectionTitle>
              <Card className="space-y-4 p-4">
                <MetricBar label="CPU" value={avgCpu} />
                <MetricBar label="RAM" value={avgRam} />
                <MetricBar label="Disk" value={avgDisk} />
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="rounded-lg bg-[#0c0e16] p-3">
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">трафик</div>
                    <div className="mt-1 text-lg font-bold text-[#38bdf8]">{formatBytes(networkTotal)}</div>
                  </div>
                  <div className="rounded-lg bg-[#0c0e16] p-3">
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">нагрето</div>
                    <div className="mt-1 text-lg font-bold text-[#fbbf24]">{hotNodes.length}</div>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#e8eaf6]"><Server size={15} /> Где</div>
            <div className="space-y-2">
              {inventory.slice(0, 5).map(({ node }) => (
                <div key={node.id} className="flex items-center justify-between gap-3 rounded-lg bg-[#0c0e16] px-3 py-2 font-mono text-xs">
                  <span className="truncate text-[#8892b0]">{node.location || node.provider || "локация не задана"}</span>
                  <span className="text-[#4a5170]">{node.name}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#e8eaf6]"><RadioTower size={15} /> Что открыто</div>
            <div className="space-y-2">
              {ports.filter((port) => port.status === "open").slice(0, 5).map((port) => (
                <div key={port.id} className="flex items-center justify-between gap-3 rounded-lg bg-[#0c0e16] px-3 py-2 font-mono text-xs">
                  <span className="text-[#a78bfa]">{port.protocol}/{port.port}</span>
                  <span className="truncate text-[#4a5170]">{port.node_name}</span>
                </div>
              ))}
              {openPorts === 0 && <div className="font-mono text-xs text-[#2a3355]">Открытых портов не найдено</div>}
            </div>
          </Card>
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#e8eaf6]"><Clock3 size={15} /> Когда</div>
            <div className="space-y-2">
              {events.slice(0, 5).map((event) => (
                <div key={event.id} className="flex items-center justify-between gap-3 rounded-lg bg-[#0c0e16] px-3 py-2 font-mono text-xs">
                  <span className="truncate text-[#8892b0]">{event.message}</span>
                  <span className="shrink-0 text-[#4a5170]">{formatRelativeTime(event.created_at)}</span>
                </div>
              ))}
              {events.length === 0 && <div className="font-mono text-xs text-[#2a3355]">Хронология пустая</div>}
            </div>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
