"use client";

import type { ReactNode } from "react";
import clsx from "clsx";
import { severityLabel, statusLabel } from "@/lib/format";

export function metricColor(value: number | null | undefined): string {
  if (value == null) return "#4a5170";
  if (value >= 85) return "#f87171";
  if (value >= 60) return "#fbbf24";
  return "#4ade80";
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-xl border border-[#1d2135] bg-[#111420] shadow-[0_18px_55px_rgba(0,0,0,0.18)]", className)}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("mb-3 flex items-center gap-3", className)}>
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#4a5170]">{children}</span>
      <div className="h-px flex-1 bg-[#1a1d2e]" />
    </div>
  );
}

export function StatusDot({ status, size = 8 }: { status: string | null | undefined; size?: number }) {
  const color = {
    online: "#4ade80",
    offline: "#f87171",
    pending: "#fbbf24",
    master: "#818cf8",
    running: "#4ade80",
    stopped: "#f87171",
  }[status ?? ""] ?? "#4a5170";

  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: `0 0 ${size + 3}px ${color}70`,
      }}
    />
  );
}

export function Pill({ children, color = "gray", className }: { children: ReactNode; color?: "green" | "red" | "blue" | "purple" | "yellow" | "gray"; className?: string }) {
  const styles = {
    green: "bg-[#4ade80]/10 text-[#4ade80] border-[#4ade80]/15",
    red: "bg-[#f87171]/10 text-[#f87171] border-[#f87171]/15",
    blue: "bg-[#38bdf8]/10 text-[#38bdf8] border-[#38bdf8]/15",
    purple: "bg-[#a78bfa]/10 text-[#a78bfa] border-[#a78bfa]/15",
    yellow: "bg-[#fbbf24]/10 text-[#fbbf24] border-[#fbbf24]/15",
    gray: "bg-[#1a1d2e] text-[#4a5170] border-[#252a40]",
  }[color];

  return <span className={clsx("inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px]", styles, className)}>{children}</span>;
}

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const color = severity === "critical" ? "red" : severity === "warning" ? "yellow" : "blue";
  return <Pill color={color}>{severityLabel(severity)}</Pill>;
}

export function MetricBar({ label, value }: { label: string; value: number | null | undefined }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const color = metricColor(value);

  return (
    <div className="flex items-center gap-2">
      <div className="w-9 shrink-0 font-mono text-[10px] text-[#2a3355]">{label}</div>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#1a1d2e]">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="w-10 shrink-0 text-right font-mono text-[10px] text-[#4a5170]">{value == null ? "-" : `${Math.round(value)}%`}</div>
    </div>
  );
}

export function SparkBars({ values, color = "#4ade80", className }: { values: number[]; color?: string; className?: string }) {
  const safeValues = values.length ? values : [8, 14, 10, 18, 12, 20, 16, 24, 18, 28, 22, 30];
  const max = Math.max(...safeValues, 1);

  return (
    <div className={clsx("flex h-10 items-end gap-1", className)}>
      {safeValues.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className="flex-1 rounded-t-sm"
          style={{
            minHeight: 3,
            height: `${Math.max(8, (value / max) * 100)}%`,
            background: color,
            opacity: 0.35 + (index / safeValues.length) * 0.65,
          }}
        />
      ))}
    </div>
  );
}

export function StatCard({ label, value, sub, color = "#4ade80" }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <Card className="relative overflow-hidden p-4">
      <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: color }} />
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#4a5170]">{label}</div>
      <div className="text-3xl font-bold leading-none" style={{ color }}>{value}</div>
      {sub && <div className="mt-2 font-mono text-[10px] text-[#2a3355]">{sub}</div>}
    </Card>
  );
}

export function SoftButton({ children, variant = "ghost", className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "blue" | "yellow" }) {
  const styles = {
    primary: "border-[#4ade80]/60 bg-[#4ade80] text-[#06110a] hover:bg-[#63ef93]",
    ghost: "border-[#1d2135] bg-transparent text-[#4a5170] hover:border-[#2a3355] hover:text-[#dde2f0]",
    danger: "border-[#f87171]/20 bg-[#f87171]/10 text-[#f87171] hover:bg-[#f87171]/15",
    blue: "border-[#38bdf8]/20 bg-[#38bdf8]/10 text-[#38bdf8] hover:bg-[#38bdf8]/15",
    yellow: "border-[#fbbf24]/20 bg-[#fbbf24]/10 text-[#fbbf24] hover:bg-[#fbbf24]/15",
  }[variant];

  return (
    <button
      {...props}
      className={clsx("inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50", styles, className)}
    >
      {children}
    </button>
  );
}

export function SearchBar({ value, onChange, placeholder = "Поиск...", className }: { value: string; onChange: (value: string) => void; placeholder?: string; className?: string }) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className={clsx("w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2 font-mono text-xs text-[#dde2f0] outline-none transition placeholder:text-[#2a3355] focus:border-[#4ade80]/70", className)}
    />
  );
}

export function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "rounded-md border px-3 py-1.5 text-xs font-semibold transition",
        active
          ? "border-[#4ade80] bg-[#4ade80] text-[#06110a]"
          : "border-[#1d2135] text-[#4a5170] hover:border-[#2a3355] hover:text-[#dde2f0]"
      )}
    >
      {label}
    </button>
  );
}

export interface DataColumn<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({ columns, rows, emptyText = "Нет данных" }: { columns: DataColumn<T>[]; rows: T[]; emptyText?: string }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={clsx("border-b border-[#1a1d2e] px-4 py-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-[#2a3355]", column.className)}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center font-mono text-xs text-[#2a3355]">
                  {emptyText}
                </td>
              </tr>
            ) : rows.map((row, index) => (
              <tr key={index} className="transition hover:bg-[#141722]">
                {columns.map((column) => (
                  <td key={column.key} className={clsx("border-b border-[#0f1218] px-4 py-3 font-mono text-xs text-[#8892b0]", column.className)}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function StatusPill({ status }: { status: string | null | undefined }) {
  const color = status === "online" || status === "running" || status === "open" || status === "success" ? "green" : status === "offline" || status === "stopped" || status === "failed" ? "red" : "yellow";
  return (
    <Pill color={color}>
      <StatusDot status={status} size={6} />
      <span className="ml-1">{statusLabel(status)}</span>
    </Pill>
  );
}
