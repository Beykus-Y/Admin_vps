"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, ArrowUpCircle, Bell, Box, LayoutDashboard, Loader2, LogOut, RadioTower, Server } from "lucide-react";
import clsx from "clsx";
import { api, VersionInfo } from "@/lib/api";

const nav = [
  { href: "/dashboard", label: "Обзор", icon: LayoutDashboard },
  { href: "/nodes", label: "Ноды", icon: Server },
  { href: "/containers", label: "Контейнеры", icon: Box },
  { href: "/ports", label: "Порты", icon: RadioTower },
  { href: "/events", label: "События", icon: Activity },
  { href: "/alerts", label: "Алерты", icon: Bell },
];

function pageTitle(pathname: string): string {
  if (pathname.startsWith("/nodes/")) return "Карточка ноды";
  return nav.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.label ?? "FilinControl";
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [masterUpdateLoading, setMasterUpdateLoading] = useState(false);
  const [masterUpdateMsg, setMasterUpdateMsg] = useState<string | null>(null);
  const [clock, setClock] = useState("");

  useEffect(() => {
    api.version().then(setVersionInfo).catch(() => null);
  }, []);

  useEffect(() => {
    const tick = () => {
      setClock(new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date()));
    };
    tick();
    const timer = window.setInterval(tick, 30000);
    return () => window.clearInterval(timer);
  }, []);

  function logout() {
    localStorage.removeItem("token");
    router.push("/login");
  }

  async function updateMaster() {
    if (!window.confirm("Запланировать обновление мастер-стека сейчас?")) return;
    setMasterUpdateLoading(true);
    setMasterUpdateMsg(null);
    try {
      const task = await api.master.update();
      setMasterUpdateMsg(`задача ${task.id.slice(0, 8)} создана`);
    } catch (err: unknown) {
      setMasterUpdateMsg(err instanceof Error ? err.message : "обновление не удалось");
    } finally {
      setMasterUpdateLoading(false);
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#0c0e16] text-[#dde2f0]">
      <aside className="flex w-[68px] shrink-0 flex-col border-r border-[#151826] bg-[#080a11] sm:w-[216px]">
        <div className="border-b border-[#151826] px-4 py-4 sm:px-5">
          <Link href="/dashboard" className="block font-mono text-sm font-semibold tracking-[0.08em] text-[#4ade80]">
            <span className="sm:hidden">FC</span>
            <span className="hidden sm:inline">Filin<span className="font-normal text-[#2a3355]">Control</span></span>
          </Link>
        </div>

        <nav className="flex-1 space-y-1 px-2 py-3 sm:px-0">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`) || (href === "/nodes" && pathname.startsWith("/nodes/"));
            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  "group flex items-center gap-3 border-l-2 px-3 py-2.5 text-sm font-medium transition sm:px-5",
                  active
                    ? "border-[#4ade80] bg-white/[0.035] text-[#dde2f0]"
                    : "border-transparent text-[#3a4460] hover:bg-white/[0.025] hover:text-[#7a88aa]"
                )}
                title={label}
              >
                <Icon size={16} className="shrink-0" />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[#151826] p-3 sm:p-4">
          <div className="hidden space-y-2 font-mono text-[10px] text-[#2a3050] sm:block">
            <div className="flex items-center gap-2 text-[#4a5170]">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#4ade80]" />
              мастер онлайн
            </div>
            {versionInfo && (
              <div className="space-y-1 rounded-lg border border-[#111420] bg-[#0c0e16] p-2">
                <div className="flex justify-between gap-3">
                  <span>master</span>
                  <span className="text-[#4a5170]">{versionInfo.master_version}</span>
                </div>
                {versionInfo.latest_agent_version && (
                  <div className="flex justify-between gap-3">
                    <span>agent</span>
                    <span className="text-[#4a5170]">{versionInfo.latest_agent_version}</span>
                  </div>
                )}
              </div>
            )}
            <button
              onClick={updateMaster}
              disabled={masterUpdateLoading}
              className="flex w-full items-center gap-2 rounded-md border border-[#1d2135] bg-[#111420] px-3 py-2 text-left text-[#3a4460] transition hover:border-[#4ade80] hover:text-[#4ade80] disabled:opacity-50"
              title="Подтянуть последние образы master и перезапустить стек через мастер-агент"
            >
              {masterUpdateLoading ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpCircle size={13} />}
              Обновить мастер
            </button>
            {masterUpdateMsg && <div className="break-words text-[#4a5170]">{masterUpdateMsg}</div>}
          </div>

          <button
            onClick={logout}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-md px-2 py-2 text-sm text-[#3a4460] transition hover:bg-[#111420] hover:text-[#f87171] sm:justify-start sm:px-3"
            title="Выйти"
          >
            <LogOut size={15} />
            <span className="hidden sm:inline">Выйти</span>
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[#151826] bg-[#080a11] px-4 py-3 sm:px-6">
          <div>
            <div className="text-lg font-bold tracking-[-0.02em] text-[#e8eaf6] sm:text-xl">{pageTitle(pathname)}</div>
            <div className="mt-0.5 hidden font-mono text-[10px] uppercase tracking-[0.16em] text-[#2a3355] sm:block">панель наблюдения и управления</div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden font-mono text-[11px] text-[#2a3355] md:block">{clock}</div>
            <Link href="/nodes" className="rounded-lg border border-[#4ade80]/60 bg-[#4ade80] px-3 py-2 text-sm font-semibold text-[#06110a] transition hover:bg-[#63ef93]">
              + Нода
            </Link>
          </div>
        </header>

        <main className="view-enter min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
