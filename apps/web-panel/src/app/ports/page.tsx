"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Layout from "@/components/Layout";
import { api } from "@/lib/api";
import { flattenPorts, InventoryPort, loadInventory } from "@/lib/inventory";
import { formatDateTime, formatNumber } from "@/lib/format";
import { DataTable, FilterChip, Pill, SearchBar, StatCard, StatusPill } from "@/components/ui";

type Filter = "all" | "unexpected" | "public" | "stale";

function isPublicPort(port: InventoryPort): boolean {
  return !port.listen_ip || port.listen_ip === "0.0.0.0" || port.listen_ip === "::";
}

export default function PortsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<InventoryPort[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState<string | null>(null);

  async function load() {
    const inventory = await loadInventory();
    setRows(flattenPorts(inventory));
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }

    load()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Не удалось загрузить порты";
        if (message.includes("401")) router.push("/login");
        else setError(message);
      })
      .finally(() => setLoading(false));
  }, [router]);

  async function markExpected(port: InventoryPort) {
    setUpdating(port.id);
    try {
      await api.nodes.markPortExpected(port.node_id, port.id, true);
      await load();
    } finally {
      setUpdating(null);
    }
  }

  const open = rows.filter((port) => port.status === "open").length;
  const unexpected = rows.filter((port) => port.status === "open" && !port.is_expected).length;
  const publicCount = rows.filter((port) => port.status === "open" && isPublicPort(port)).length;
  const stale = rows.filter((port) => port.status === "stale").length;
  const filtered = rows.filter((port) => {
    if (filter === "unexpected" && (port.is_expected || port.status !== "open")) return false;
    if (filter === "public" && (port.status !== "open" || !isPublicPort(port))) return false;
    if (filter === "stale" && port.status !== "stale") return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [port.port, port.protocol, port.listen_ip, port.process_name, port.container_name, port.node_name, port.user_name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Всего" value={formatNumber(rows.length)} sub="в инвентаре" color="#a78bfa" />
          <StatCard label="Открыто" value={formatNumber(open)} sub="свежие от агентов" color="#4ade80" />
          <StatCard label="Публичные" value={formatNumber(publicCount)} sub="0.0.0.0 или ::" color="#fbbf24" />
          <StatCard label="Неожиданные" value={formatNumber(unexpected)} sub={unexpected ? "проверьте доступ" : "всё ожидаемо"} color={unexpected ? "#f87171" : "#4ade80"} />
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-wrap gap-2">
            <FilterChip label="Все" active={filter === "all"} onClick={() => setFilter("all")} />
            <FilterChip label="Неожиданные" active={filter === "unexpected"} onClick={() => setFilter("unexpected")} />
            <FilterChip label="Публичные" active={filter === "public"} onClick={() => setFilter("public")} />
            <FilterChip label={`Устаревшие (${stale})`} active={filter === "stale"} onClick={() => setFilter("stale")} />
          </div>
          <SearchBar value={search} onChange={setSearch} placeholder="Порт, процесс, контейнер или нода..." className="lg:ml-auto lg:max-w-sm" />
        </div>

        {error ? (
          <div className="text-[#f87171]">{error}</div>
        ) : loading ? (
          <div className="font-mono text-sm text-[#4a5170]">Загружаю порты...</div>
        ) : (
          <DataTable
            rows={filtered}
            emptyText="Порты не найдены"
            columns={[
              {
                key: "port",
                label: "Порт",
                render: (row) => <Pill color="purple">{row.protocol}/{row.port}</Pill>,
              },
              {
                key: "addr",
                label: "Адрес",
                render: (row) => <span className={isPublicPort(row) ? "text-[#fbbf24]" : "text-[#4a5170]"}>{row.listen_ip || "0.0.0.0"}</span>,
              },
              {
                key: "process",
                label: "Процесс",
                render: (row) => <span className="text-[#dde2f0]">{row.process_name || "-"}</span>,
              },
              {
                key: "container",
                label: "Контейнер",
                render: (row) => row.container_name || <span className="text-[#2a3355]">нет</span>,
              },
              {
                key: "node",
                label: "Нода",
                render: (row) => <Link href={`/nodes/${row.node_id}`} className="text-[#818cf8] hover:text-[#a5b4fc]">{row.node_name}</Link>,
              },
              {
                key: "state",
                label: "Статус",
                render: (row) => <StatusPill status={row.status} />,
              },
              {
                key: "expected",
                label: "Ожидаемый",
                render: (row) => row.is_expected ? (
                  <Pill color="green">да</Pill>
                ) : (
                  <button
                    onClick={() => markExpected(row)}
                    disabled={updating === row.id}
                    className="text-[#fbbf24] underline-offset-4 hover:underline disabled:opacity-50"
                  >
                    считать ожидаемым
                  </button>
                ),
              },
              {
                key: "last",
                label: "Когда",
                render: (row) => formatDateTime(row.last_seen_at),
              },
            ]}
          />
        )}
      </div>
    </Layout>
  );
}
