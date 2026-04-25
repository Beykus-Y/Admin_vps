"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Layout from "@/components/Layout";
import { flattenContainers, InventoryContainer, loadInventory } from "@/lib/inventory";
import { formatDateTime, formatNumber, formatPercent, statusLabel } from "@/lib/format";
import { DataTable, FilterChip, Pill, SearchBar, StatCard, StatusPill } from "@/components/ui";
import { useLiveReload } from "@/lib/live";

type Filter = "all" | "running" | "stopped";

export default function ContainersPage() {
  const router = useRouter();
  const [rows, setRows] = useState<InventoryContainer[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return Promise.resolve();
    }

    return loadInventory()
      .then((inventory) => setRows(flattenContainers(inventory)))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Не удалось загрузить контейнеры";
        if (message.includes("401")) router.push("/login");
        else setError(message);
      })
      .finally(() => setLoading(false));
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveReload(!loading, load);

  const running = rows.filter((container) => container.state === "running").length;
  const stopped = rows.length - running;
  const withPorts = rows.filter((container) => container.ports.length > 0).length;
  const filtered = rows.filter((container) => {
    if (filter === "running" && container.state !== "running") return false;
    if (filter === "stopped" && container.state === "running") return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [container.name, container.image, container.node_name, container.ports.join(" ")]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Всего" value={formatNumber(rows.length)} sub="по всем нодам" color="#dde2f0" />
          <StatCard label="Запущено" value={formatNumber(running)} sub="состояние running" color="#4ade80" />
          <StatCard label="Остановлено" value={formatNumber(stopped)} sub="нужна проверка" color={stopped ? "#f87171" : "#4ade80"} />
          <StatCard label="С портами" value={formatNumber(withPorts)} sub="есть публикации" color="#a78bfa" />
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-wrap gap-2">
            <FilterChip label="Все" active={filter === "all"} onClick={() => setFilter("all")} />
            <FilterChip label="Запущены" active={filter === "running"} onClick={() => setFilter("running")} />
            <FilterChip label="Остановлены" active={filter === "stopped"} onClick={() => setFilter("stopped")} />
          </div>
          <SearchBar value={search} onChange={setSearch} placeholder="Контейнер, образ, нода или порт..." className="lg:ml-auto lg:max-w-sm" />
        </div>

        {error ? (
          <div className="text-[#f87171]">{error}</div>
        ) : loading ? (
          <div className="font-mono text-sm text-[#4a5170]">Загружаю контейнеры...</div>
        ) : (
          <DataTable
            rows={filtered}
            emptyText="Контейнеры не найдены"
            columns={[
              {
                key: "name",
                label: "Контейнер",
                render: (row) => (
                  <div>
                    <div className="font-sans text-sm font-semibold text-[#dde2f0]">{row.name}</div>
                    <div className="mt-1 max-w-[360px] truncate text-[#4a5170]">{row.image || "образ не указан"}</div>
                  </div>
                ),
              },
              {
                key: "node",
                label: "Нода",
                render: (row) => <Link href={`/nodes/${row.node_id}`} className="text-[#818cf8] hover:text-[#a5b4fc]">{row.node_name}</Link>,
              },
              {
                key: "ports",
                label: "Порты",
                render: (row) => row.ports.length ? <Pill color="purple">{row.ports.join(", ")}</Pill> : <span className="text-[#2a3355]">нет</span>,
              },
              {
                key: "cpu",
                label: "CPU",
                render: (row) => formatPercent(row.cpu_percent),
              },
              {
                key: "ram",
                label: "RAM",
                render: (row) => row.ram_mb != null ? `${Math.round(row.ram_mb)} МБ` : "-",
              },
              {
                key: "status",
                label: "Статус",
                render: (row) => <StatusPill status={row.state || row.status} />,
              },
              {
                key: "updated",
                label: "Когда",
                render: (row) => <span title={formatDateTime(row.updated_at)}>{row.updated_at ? formatDateTime(row.updated_at) : statusLabel(null)}</span>,
              },
            ]}
          />
        )}
      </div>
    </Layout>
  );
}
