"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Layout from "@/components/Layout";
import { api, isAgentOutdated, VersionInfo } from "@/lib/api";
import { flattenContainers, flattenPorts, InventoryNode, loadInventory } from "@/lib/inventory";
import { formatNumber } from "@/lib/format";
import { Card, Pill, SoftButton, StatCard } from "@/components/ui";

interface AlertRule {
  id: string;
  name: string;
  desc: string;
  severity: "critical" | "warning" | "info";
  triggered: number;
}

const DEFAULT_ENABLED: Record<string, boolean> = {
  node_offline: true,
  cpu_high: true,
  ram_high: true,
  disk_high: false,
  new_port: true,
  container_down: true,
  agent_outdated: false,
};

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`relative h-5 w-9 rounded-full transition ${checked ? "bg-[#4ade80]" : "bg-[#1d2135]"}`}
      aria-pressed={checked}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

function buildRules(inventory: InventoryNode[], versionInfo: VersionInfo | null): AlertRule[] {
  const containers = flattenContainers(inventory);
  const ports = flattenPorts(inventory);
  const offlineNodes = inventory.filter(({ node }) => node.status === "offline").length;
  const highCpu = inventory.filter(({ metrics }) => (metrics?.cpu_percent ?? 0) >= 90).length;
  const highRam = inventory.filter(({ metrics }) => metrics?.ram_used_mb != null && metrics.ram_total_mb ? (metrics.ram_used_mb / metrics.ram_total_mb) * 100 >= 85 : false).length;
  const highDisk = inventory.filter(({ metrics }) => metrics?.disk_used_gb != null && metrics.disk_total_gb ? (metrics.disk_used_gb / metrics.disk_total_gb) * 100 >= 80 : false).length;
  const unexpectedPorts = ports.filter((port) => port.status === "open" && !port.is_expected).length;
  const stoppedContainers = containers.filter((container) => container.state !== "running").length;
  const outdatedAgents = inventory.filter(({ node }) => node.status === "online" && isAgentOutdated(node.agent_version, versionInfo?.latest_agent_version ?? null)).length;

  return [
    { id: "node_offline", name: "Нода оффлайн", desc: "Нода не отвечает дольше заданного порога", severity: "critical", triggered: offlineNodes },
    { id: "cpu_high", name: "CPU > 90%", desc: "Высокая загрузка CPU на одной или нескольких нодах", severity: "warning", triggered: highCpu },
    { id: "ram_high", name: "RAM > 85%", desc: "Оперативная память близка к пределу", severity: "warning", triggered: highRam },
    { id: "disk_high", name: "Диск > 80%", desc: "Свободное место заканчивается", severity: "warning", triggered: highDisk },
    { id: "new_port", name: "Новый открытый порт", desc: "Появился порт, который ещё не отмечен как ожидаемый", severity: "warning", triggered: unexpectedPorts },
    { id: "container_down", name: "Контейнер остановлен", desc: "Docker-контейнер не находится в состоянии running", severity: "warning", triggered: stoppedContainers },
    { id: "agent_outdated", name: "Агент устарел", desc: "Доступна более новая версия агента", severity: "info", triggered: outdatedAgents },
  ];
}

export default function AlertsPage() {
  const router = useRouter();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [enabled, setEnabled] = useState(DEFAULT_ENABLED);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }

    Promise.all([loadInventory(), api.version().catch(() => null as VersionInfo | null)])
      .then(([inventory, versionInfo]) => setRules(buildRules(inventory, versionInfo)))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Не удалось загрузить алерты";
        if (message.includes("401")) router.push("/login");
        else setError(message);
      })
      .finally(() => setLoading(false));
  }, [router]);

  const activeRules = rules.filter((rule) => enabled[rule.id]).length;
  const triggered = rules.reduce((sum, rule) => sum + (enabled[rule.id] ? rule.triggered : 0), 0);
  const critical = rules.filter((rule) => enabled[rule.id] && rule.severity === "critical" && rule.triggered > 0).length;

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Правил" value={formatNumber(rules.length)} sub="локальный мониторинг" color="#dde2f0" />
          <StatCard label="Активных" value={formatNumber(activeRules)} sub="включены сейчас" color="#4ade80" />
          <StatCard label="Сработало" value={formatNumber(triggered)} sub="по текущим данным" color={triggered ? "#fbbf24" : "#4ade80"} />
          <StatCard label="Критично" value={formatNumber(critical)} sub={critical ? "требует реакции" : "нет"} color={critical ? "#f87171" : "#4ade80"} />
        </div>

        {error ? (
          <div className="text-[#f87171]">{error}</div>
        ) : loading ? (
          <div className="font-mono text-sm text-[#4a5170]">Загружаю правила алертов...</div>
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => {
              const isEnabled = enabled[rule.id];
              const color = rule.severity === "critical" ? "#f87171" : rule.severity === "warning" ? "#fbbf24" : "#38bdf8";
              return (
                <Card key={rule.id} className={`flex flex-col gap-4 p-4 transition sm:flex-row sm:items-center ${isEnabled ? "opacity-100" : "opacity-55"}`}>
                  <div className="h-12 w-1.5 shrink-0 rounded-full" style={{ background: isEnabled ? color : "#1d2135" }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[#e8eaf6]">{rule.name}</div>
                    <div className="mt-1 font-mono text-xs text-[#4a5170]">{rule.desc}</div>
                  </div>
                  {rule.triggered > 0 && (
                    <div className="text-left sm:text-center">
                      <div className="text-xl font-bold text-[#fbbf24]">{rule.triggered}</div>
                      <div className="font-mono text-[9px] text-[#4a5170]">сработало</div>
                    </div>
                  )}
                  <Pill color={rule.severity === "critical" ? "red" : rule.severity === "warning" ? "yellow" : "blue"}>{rule.severity === "critical" ? "крит" : rule.severity === "warning" ? "важно" : "инфо"}</Pill>
                  <Toggle checked={isEnabled} onChange={() => setEnabled((prev) => ({ ...prev, [rule.id]: !prev[rule.id] }))} />
                </Card>
              );
            })}

            <Card className="flex items-center justify-center border-dashed border-[#1d2135] p-5">
              <SoftButton variant="ghost" disabled>+ Создание кастомных правил скоро</SoftButton>
            </Card>
          </div>
        )}
      </div>
    </Layout>
  );
}
