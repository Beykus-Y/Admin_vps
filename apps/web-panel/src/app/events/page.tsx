"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Layout from "@/components/Layout";
import { api } from "@/lib/api";
import { flattenEvents, InventoryEvent, loadInventory } from "@/lib/inventory";
import { formatDateTime, formatNumber, formatRelativeTime } from "@/lib/format";
import { DataTable, FilterChip, SearchBar, SeverityBadge, StatCard } from "@/components/ui";

type Filter = "all" | "critical" | "warning" | "info";

export default function EventsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<InventoryEvent[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }

    Promise.all([loadInventory(), api.overview()])
      .then(([inventory, overview]) => {
        const nodeEvents = flattenEvents(inventory);
        if (nodeEvents.length) {
          setRows(nodeEvents);
          return;
        }

        setRows(overview.recent_events.map((event) => ({ ...event, node_name: "системное событие" })));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Не удалось загрузить события";
        if (message.includes("401")) router.push("/login");
        else setError(message);
      })
      .finally(() => setLoading(false));
  }, [router]);

  const critical = rows.filter((event) => event.severity === "critical").length;
  const warning = rows.filter((event) => event.severity === "warning").length;
  const info = rows.filter((event) => event.severity === "info").length;
  const last = rows[0]?.created_at ?? null;
  const filtered = rows.filter((event) => {
    if (filter !== "all" && event.severity !== filter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [event.message, event.type, event.node_name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Всего" value={formatNumber(rows.length)} sub="последняя выборка" color="#dde2f0" />
          <StatCard label="Критично" value={formatNumber(critical)} sub={critical ? "требует реакции" : "нет"} color={critical ? "#f87171" : "#4ade80"} />
          <StatCard label="Важно" value={formatNumber(warning)} sub="предупреждения" color="#fbbf24" />
          <StatCard label="Последнее" value={last ? formatRelativeTime(last).replace(" назад", "") : "-"} sub={formatDateTime(last)} color="#38bdf8" />
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-wrap gap-2">
            <FilterChip label="Все" active={filter === "all"} onClick={() => setFilter("all")} />
            <FilterChip label="Критические" active={filter === "critical"} onClick={() => setFilter("critical")} />
            <FilterChip label="Предупреждения" active={filter === "warning"} onClick={() => setFilter("warning")} />
            <FilterChip label={`Инфо (${info})`} active={filter === "info"} onClick={() => setFilter("info")} />
          </div>
          <SearchBar value={search} onChange={setSearch} placeholder="Событие, тип или нода..." className="lg:ml-auto lg:max-w-sm" />
        </div>

        {error ? (
          <div className="text-[#f87171]">{error}</div>
        ) : loading ? (
          <div className="font-mono text-sm text-[#4a5170]">Загружаю события...</div>
        ) : (
          <DataTable
            rows={filtered}
            emptyText="События не найдены"
            columns={[
              {
                key: "severity",
                label: "Уровень",
                render: (row) => <SeverityBadge severity={row.severity} />,
              },
              {
                key: "message",
                label: "Событие",
                render: (row) => (
                  <div>
                    <div className="font-sans text-sm text-[#dde2f0]">{row.message}</div>
                    <div className="mt-1 text-[#4a5170]">{row.type}</div>
                  </div>
                ),
              },
              {
                key: "node",
                label: "Где",
                render: (row) => row.node_id ? <Link href={`/nodes/${row.node_id}`} className="text-[#818cf8] hover:text-[#a5b4fc]">{row.node_name}</Link> : row.node_name,
              },
              {
                key: "time",
                label: "Когда",
                render: (row) => (
                  <span title={formatDateTime(row.created_at)}>{formatRelativeTime(row.created_at)}</span>
                ),
              },
            ]}
          />
        )}
      </div>
    </Layout>
  );
}
