"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Save, ShieldCheck, Wifi } from "lucide-react";
import clsx from "clsx";
import Layout from "@/components/Layout";
import { Card, Pill, SoftButton } from "@/components/ui";
import { api, SubProxyConnectionSettings } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type Notice = { type: "ok" | "err"; message: string } | null;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#4a5170]">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      type={type}
      className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2.5 text-sm text-[#dde2f0] outline-none transition placeholder:text-[#2a3355] focus:border-[#4ade80]/70"
    />
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [settings, setSettings] = useState<SubProxyConnectionSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [hmacSecret, setHmacSecret] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("10");
  const [clearSecret, setClearSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.settings.subProxy();
      setSettings(data);
      setBaseUrl(data.base_url);
      setTimeoutSeconds(String(data.timeout_seconds));
      setNotice(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Не удалось загрузить настройки";
      if (/invalid token|unauthorized|not authenticated/i.test(message)) {
        router.push("/login");
        return;
      }
      setNotice({ type: "err", message });
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.push("/dashboard");
      return;
    }
    void loadSettings();
  }, [loadSettings, router, user]);

  async function saveSettings() {
    setSaving(true);
    try {
      const parsedTimeout = Number.parseInt(timeoutSeconds, 10);
      if (Number.isNaN(parsedTimeout) || parsedTimeout < 1 || parsedTimeout > 120) {
        setNotice({ type: "err", message: "Timeout должен быть от 1 до 120 секунд" });
        return;
      }
      const result = await api.settings.saveSubProxy({
        base_url: baseUrl.trim(),
        hmac_secret: hmacSecret.trim() || null,
        clear_hmac_secret: clearSecret,
        timeout_seconds: parsedTimeout,
      });
      setSettings(result);
      setHmacSecret("");
      setClearSecret(false);
      setNotice({ type: "ok", message: "Настройки сохранены" });
    } catch (err: unknown) {
      setNotice({ type: "err", message: err instanceof Error ? err.message : "Не удалось сохранить настройки" });
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    try {
      await api.settings.testSubProxy();
      setNotice({ type: "ok", message: "Sub Proxy отвечает" });
    } catch (err: unknown) {
      setNotice({ type: "err", message: err instanceof Error ? err.message : "Sub Proxy не отвечает" });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <Layout>
        <div className="p-6 font-mono text-sm text-[#4a5170]">Загружаю настройки...</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        {notice && (
          <Card className={clsx(
            "p-4 font-mono text-xs",
            notice.type === "ok"
              ? "border-[#4ade80]/20 bg-[#4ade80]/[0.07] text-[#4ade80]"
              : "border-[#f87171]/20 bg-[#f87171]/[0.07] text-[#f87171]"
          )}>
            {notice.message}
          </Card>
        )}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={17} className="text-[#4ade80]" />
                <div className="text-sm font-semibold text-[#e8eaf6]">Sub Proxy</div>
              </div>
              <Pill color={settings?.source === "database" ? "green" : "yellow"}>
                {settings?.source === "database" ? "БД" : "env fallback"}
              </Pill>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Base URL">
                <TextInput value={baseUrl} onChange={setBaseUrl} placeholder="http://mgboost-panel:8001" />
              </Field>
              <Field label="Timeout, сек">
                <TextInput value={timeoutSeconds} onChange={setTimeoutSeconds} type="number" />
              </Field>
              <Field label="HMAC secret">
                <TextInput value={hmacSecret} onChange={setHmacSecret} type="password" placeholder={settings?.hmac_secret_set ? "секрет задан" : "секрет не задан"} />
              </Field>
              <label className="flex items-end gap-2 pb-2 text-sm text-[#8892b0]">
                <input
                  type="checkbox"
                  checked={clearSecret}
                  onChange={(event) => setClearSecret(event.target.checked)}
                  className="h-4 w-4 rounded border-[#252a40] bg-[#111420] text-[#4ade80]"
                />
                очистить секрет
              </label>
            </div>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <SoftButton onClick={saveSettings} disabled={saving} variant="primary">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                Сохранить
              </SoftButton>
              <SoftButton onClick={testConnection} disabled={testing} variant="blue">
                {testing ? <Loader2 size={15} className="animate-spin" /> : <Wifi size={15} />}
                Проверить
              </SoftButton>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#4a5170]">
              <CheckCircle2 size={13} className={settings?.hmac_secret_set ? "text-[#4ade80]" : "text-[#fbbf24]"} />
              Состояние
            </div>
            <div className="mt-3 space-y-2 font-mono text-xs">
              <div className="flex justify-between gap-3">
                <span className="text-[#4a5170]">URL</span>
                <span className="truncate text-[#dde2f0]">{settings?.base_url || "не задан"}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#4a5170]">HMAC</span>
                <span className={settings?.hmac_secret_set ? "text-[#4ade80]" : "text-[#fbbf24]"}>
                  {settings?.hmac_secret_set ? "задан" : "не задан"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#4a5170]">Timeout</span>
                <span className="text-[#dde2f0]">{settings?.timeout_seconds ?? 10} сек</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
