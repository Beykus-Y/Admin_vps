export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "нет данных";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "нет данных";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatFullDateTime(value: string | null | undefined): string {
  if (!value) return "нет данных";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "нет данных";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "никогда";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "нет данных";

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return "только что";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} д назад`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} мес назад`;
  return `${Math.floor(months / 12)} г назад`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (!seconds) return "нет данных";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}д ${hours}ч`;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  return `${minutes}м`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "-";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const digits = index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null) return "-";
  return `${Number(value.toFixed(1))}%`;
}

export function statusLabel(status: string | null | undefined): string {
  return {
    online: "онлайн",
    offline: "оффлайн",
    pending: "ожидает",
    running: "запущен",
    stopped: "остановлен",
    open: "открыт",
    stale: "устарел",
    success: "успешно",
    failed: "ошибка",
    acknowledged: "подтверждено",
    silenced: "приглушено",
    resolved: "закрыто",
  }[status ?? ""] ?? (status || "нет данных");
}

export function severityLabel(severity: string | null | undefined): string {
  return {
    info: "инфо",
    warning: "важно",
    critical: "критично",
  }[severity ?? ""] ?? (severity || "инфо");
}

export function taskTypeLabel(type: string): string {
  return {
    "agent.update": "Обновление агента",
    "container.restart": "Перезапуск контейнера",
    "container.stop": "Остановка контейнера",
    "container.start": "Запуск контейнера",
    "container.logs": "Логи контейнера",
    "docker.compose.pull": "docker compose pull",
    "docker.compose.up": "docker compose up",
    "docker.compose.down": "docker compose down",
    "system.reboot": "Перезагрузка ноды",
    "master.update": "Обновление мастера",
    "terminal.session": "Browser SSH",
    "terminal.open": "Открытие SSH",
  }[type] ?? type;
}

export function roleLabel(role: string | null | undefined): string {
  return {
    admin: "админ",
    operator: "оператор",
    viewer: "наблюдатель",
  }[role ?? ""] ?? (role || "пользователь");
}
