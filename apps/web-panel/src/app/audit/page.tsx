"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Layout from "@/components/Layout";
import { AuditLog, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, formatRelativeTime } from "@/lib/format";
import { useLiveReload } from "@/lib/live";
import { DataTable, SearchBar, StatCard } from "@/components/ui";

export default function AuditPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<AuditLog[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (authLoading) return;
    if (!user) {
      router.push("/login");
      return;
    }
    if (user.role !== "admin") {
      router.push("/dashboard");
      return;
    }
    try {
      const logs = await api.audit.list({ limit: 300 });
      setRows(logs);
      setError("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Не удалось загрузить аудит";
      if (message.includes("401")) router.push("/login");
      else setError(message);
    } finally {
      setLoading(false);
    }
  }, [authLoading, router, user]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveReload(!loading, load);

  const filtered = rows.filter((row) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return [row.action, row.actor_username, row.node_name, row.message, row.target_type, row.target_id]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Записей" value={formatNumber(rows.length)} sub="последние действия" color="#dde2f0" />
          <StatCard label="Пользователи" value={formatNumber(new Set(rows.map((row) => row.actor_username).filter(Boolean)).size)} sub="участники" color="#4ade80" />
          <StatCard label="Объекты" value={formatNumber(new Set(rows.map((row) => row.target_type).filter(Boolean)).size)} sub="типы целей" color="#38bdf8" />
          <StatCard label="Последнее" value={rows[0] ? formatRelativeTime(rows[0].created_at).replace(" назад", "") : "-"} sub={rows[0] ? formatDateTime(rows[0].created_at) : "нет"} color="#fbbf24" />
        </div>

        <div className="flex justify-end">
          <SearchBar value={search} onChange={setSearch} placeholder="action, пользователь, нода..." className="max-w-sm" />
        </div>

        {error ? (
          <div className="text-[#f87171]">{error}</div>
        ) : loading ? (
          <div className="font-mono text-sm text-[#4a5170]">Загружаю аудит...</div>
        ) : (
          <DataTable
            rows={filtered}
            emptyText="Записей аудита пока нет"
            columns={[
              { key: "time", label: "Когда", render: (row) => <span title={formatDateTime(row.created_at)}>{formatRelativeTime(row.created_at)}</span> },
              { key: "actor", label: "Кто", render: (row) => row.actor_username || <span className="text-[#2a3355]">system</span> },
              { key: "action", label: "Действие", render: (row) => <span className="text-[#dde2f0]">{row.action}</span> },
              { key: "target", label: "Цель", render: (row) => row.node_id ? <Link href={`/nodes/${row.node_id}`} className="text-[#818cf8] hover:text-[#a5b4fc]">{row.node_name || row.target_id || "-"}</Link> : row.target_id || row.target_type || "-" },
              { key: "message", label: "Сообщение", render: (row) => row.message || <span className="text-[#2a3355]">-</span> },
            ]}
          />
        )}
      </div>
    </Layout>
  );
}
