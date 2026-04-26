"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, CheckCircle2, Loader2, Save, ShieldCheck, Wifi } from "lucide-react";
import clsx from "clsx";
import Layout from "@/components/Layout";
import { Card, Pill, SoftButton } from "@/components/ui";
import { api, Node, SubProxyConnectionSettings, TelegramBotSettings } from "@/lib/api";
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

  // Sub Proxy state
  const [settings, setSettings] = useState<SubProxyConnectionSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [hmacSecret, setHmacSecret] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("10");
  const [clearSecret, setClearSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Telegram Bot state
  const [botSettings, setBotSettings] = useState<TelegramBotSettings | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [botRunnerNodeId, setBotRunnerNodeId] = useState<string>("");
  const [botToken, setBotToken] = useState("");
  const [allowedChatIds, setAllowedChatIds] = useState("");
  const [savingBot, setSavingBot] = useState(false);

  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const [subProxyData, botData, nodesData] = await Promise.all([
        api.settings.subProxy(),
        api.settings.telegramBot(),
        api.nodes.list(),
      ]);
      setSettings(subProxyData);
      setBaseUrl(subProxyData.base_url);
      setTimeoutSeconds(String(subProxyData.timeout_seconds));
      setBotSettings(botData);
      setBotRunnerNodeId(botData.runner_node_id ?? "");
      setAllowedChatIds((botData.allowed_chat_ids ?? []).join(", "));
      setNodes(nodesData);
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

  async function saveBotSettings() {
    setSavingBot(true);
    try {
      const chatIds = allowedChatIds
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n));
      const result = await api.settings.saveTelegramBot({
        runner_node_id: botRunnerNodeId || null,
        bot_token: botToken.trim() || null,
        allowed_chat_ids: chatIds,
      });
      setBotSettings(result);
      setBotToken("");
      setNotice({ type: "ok", message: "Настройки бота сохранены" });
    } catch (err: unknown) {
      setNotice({ type: "err", message: err instanceof Error ? err.message : "Не удалось сохранить настройки бота" });
    } finally {
      setSavingBot(false);
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

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="p-4">
            <div className="mb-4 flex items-center gap-2">
              <Bot size={17} className="text-[#60a5fa]" />
              <div className="text-sm font-semibold text-[#e8eaf6]">Telegram Bot</div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Запускать бот на ноде">
                <select
                  value={botRunnerNodeId}
                  onChange={(e) => setBotRunnerNodeId(e.target.value)}
                  className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2.5 text-sm text-[#dde2f0] outline-none transition focus:border-[#60a5fa]/70"
                >
                  <option value="">— не запускать —</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} ({n.status}){n.public_ip ? ` — ${n.public_ip}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Bot Token">
                <TextInput
                  value={botToken}
                  onChange={setBotToken}
                  type="password"
                  placeholder={botSettings?.bot_token_set ? "токен задан" : "вставьте токен от @BotFather"}
                />
              </Field>
              <Field label="Allowed Chat IDs (через запятую)">
                <TextInput
                  value={allowedChatIds}
                  onChange={setAllowedChatIds}
                  placeholder="123456789, 987654321"
                />
              </Field>
            </div>

            <div className="mt-5">
              <SoftButton onClick={saveBotSettings} disabled={savingBot} variant="primary">
                {savingBot ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                Сохранить
              </SoftButton>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#4a5170]">
              <CheckCircle2
                size={13}
                className={botSettings?.runner_node_id && botSettings?.bot_token_set ? "text-[#4ade80]" : "text-[#fbbf24]"}
              />
              Состояние бота
            </div>
            <div className="mt-3 space-y-2 font-mono text-xs">
              <div className="flex justify-between gap-3">
                <span className="text-[#4a5170]">Runner</span>
                <span className="truncate text-[#dde2f0]">
                  {botSettings?.runner_node_id
                    ? (nodes.find((n) => n.id === botSettings.runner_node_id)?.name ?? botSettings.runner_node_id)
                    : "не задан"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#4a5170]">Token</span>
                <span className={botSettings?.bot_token_set ? "text-[#4ade80]" : "text-[#fbbf24]"}>
                  {botSettings?.bot_token_set ? "задан" : "не задан"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#4a5170]">Chat IDs</span>
                <span className="text-[#dde2f0]">
                  {botSettings?.allowed_chat_ids?.length
                    ? botSettings.allowed_chat_ids.join(", ")
                    : "все (не ограничено)"}
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
