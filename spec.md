# N — единая панель управления VPS

## 1. Задумка

**N** — это собственный сервис для управления несколькими VPS из одной панели.

Проблема, которую он решает:

- сложно помнить, где какие порты открыты;
- сложно помнить, какие Docker-контейнеры на каком сервере;
- неудобно вручную заходить на каждый VPS;
- нет единой картины по CPU/RAM/Disk/Network;
- непонятно, какие сервисы где крутятся;
- нет истории изменений;
- нет алертов по неожиданным событиям;
- нет нормального способа быстро добавить новую ноду.

Цель проекта — сделать **свой центр управления инфраструктурой**, где один главный сервер знает состояние всех остальных VPS.

---

## 2. Главная идея архитектуры

Выбираем модель:

```text
Master VPS + Agent на каждой ноде
```

Схема:

```text
                ┌─────────────────────────┐
                │        MASTER VPS        │
                │  Panel + API + DB + WS   │
                └────────────┬────────────┘
                             ▲
                             │ HTTPS / WSS
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────┴───────┐    ┌───────┴───────┐    ┌───────┴───────┐
│  VPS Agent 1  │    │  VPS Agent 2  │    │  VPS Agent 3  │
│ Docker/Ports  │    │ Docker/Ports  │    │ Docker/Ports  │
│ Metrics       │    │ Metrics       │    │ Metrics       │
└───────────────┘    └───────────────┘    └───────────────┘
```

Master хранит данные, показывает Web UI, принимает snapshots, управляет задачами и отправляет команды агентам.

Agent установлен на каждой VPS и сам подключается к Master.

---

## 3. Почему не Web3 / P2P

Web3/P2P для этой задачи не нужен.

N не требует:

- блокчейна;
- распределённого консенсуса;
- peer-to-peer-сети;
- децентрализованной валидации;
- токенов/кошельков/подписей транзакций.

Нужно другое:

- знать состояние серверов;
- собирать телеметрию;
- видеть Docker-контейнеры;
- видеть открытые порты;
- управлять безопасными действиями;
- быстро добавлять новые VPS;
- получать алерты.

Для этого лучше всего подходит **центральный Master + легковесные агенты**.

---

## 4. Почему не SSH-polling

Альтернативный вариант — Master подключается ко всем VPS по SSH и сам всё проверяет.

Схема:

```text
Master -> SSH -> VPS 1
Master -> SSH -> VPS 2
Master -> SSH -> VPS 3
```

Это можно сделать быстро, но у подхода есть проблемы:

- Master должен хранить SSH-ключи ко всем VPS;
- Master становится слишком опасной точкой взлома;
- сложнее работать с firewall/NAT;
- сложнее делать real-time;
- сложнее делать нормальные очереди задач;
- при проблемах с сетью SSH-сессии будут ломаться;
- неудобно масштабировать;
- сложнее контролировать, какие команды разрешены.

SSH можно оставить как аварийный ручной способ, но не как основу продукта.

---

## 5. Основной принцип связи

Agent должен сам подключаться к Master.

Правильно:

```text
Agent -> Master
```

А не:

```text
Master -> Agent
```

Преимущества:

- на нодах не нужно открывать отдельный порт для агента;
- работает через обычный исходящий HTTPS/WSS;
- проще с firewall;
- безопаснее;
- проще добавлять новые VPS;
- Master не обязан знать, как достучаться до приватного IP ноды.

---

## 6. Компоненты системы

### 6.1 Master

Master — главный сервер системы.

Он отвечает за:

- Web UI;
- REST API;
- WebSocket API;
- регистрацию агентов;
- хранение данных;
- авторизацию пользователей;
- управление задачами;
- алерты;
- историю метрик;
- инвентаризацию серверов;
- отображение состояния инфраструктуры.

Рекомендуемый стек:

```text
Backend: FastAPI
DB: PostgreSQL
Cache/Queue: Redis
Frontend: React / Next.js / обычный SPA
Reverse proxy: Caddy
Deployment: Docker Compose
```

---

### 6.2 Agent

Agent — маленький сервис, установленный на каждой VPS.

Он отвечает за:

- сбор системных метрик;
- сбор Docker-информации;
- определение открытых портов;
- отправку heartbeat;
- отправку snapshots;
- получение задач от Master;
- выполнение разрешённых действий;
- отправку результата задач обратно на Master.

Рекомендуемый язык:

```text
Go
```

Почему Go подходит:

- один бинарник;
- простой деплой;
- хорош для системных утилит;
- удобно работать с Docker API;
- легче и быстрее в разработке, чем Rust;
- надёжнее для agent-сценария, чем Python-скрипты с зависимостями.

Rust тоже подходит, если нужен максимально строгий код и больше гарантий, но разработка будет дольше.

Python можно использовать для самого первого прототипа, но не как финальный вариант агента.

---

## 7. Onboarding новой ноды

Один из ключевых UX-сценариев:

```text
1. В Master-панели нажать "Добавить ноду"
2. Ввести имя/описание/группу/ожидаемый IP
3. Master создаёт pending-node
4. Master генерирует одноразовый install token
5. Master показывает готовую install-команду
6. Команду нужно вставить на новой VPS
7. Agent устанавливается и подключается к Master
8. Master подтверждает регистрацию
9. Нода появляется в панели как online
```

Пример команды:

```bash
curl -fsSLk https://panel.example.com/install/agent.sh | sudo bash -s -- \
  --master-url "https://panel.example.com" \
  --enroll-token "fna_enroll_xxxxxxxxxxxxxxxxxxxxx"
```

---

## 8. Важное правило onboarding

Install token должен быть:

- одноразовым;
- короткоживущим;
- привязанным к pending-node;
- после использования помечаться как `used`;
- храниться в базе только в виде hash.

Правильно:

```text
Одноразовый enroll token на 15 минут
```

Плохо:

```text
Один вечный INSTALL_TOKEN для всех VPS
```

Катастрофа:

```text
Передавать master admin token в install-команду
```

---

## 9. Процесс регистрации агента

Схема:

```text
Master:
  создаёт pending-node
  создаёт enroll token
  показывает install-команду

Новая VPS:
  выполняет install-команду

Install script:
  скачивает agent binary
  вызывает /api/agent/enroll

Agent:
  отправляет enroll token
  отправляет hostname, OS, arch, public IP

Master:
  проверяет enroll token
  создаёт постоянный agent token
  помечает enroll token как used
  возвращает agent config

Agent:
  сохраняет config
  запускается как systemd service
  начинает отправлять heartbeat/snapshot
```

---

## 10. Постоянный конфиг агента

Пример:

```yaml
node_id: "node_01HXYZ"
master_url: "https://panel.example.com"
agent_token: "fna_agent_xxxxxxxxxxxxxxxxxxxxxxxxx"
collect_interval_seconds: 10
task_poll_interval_seconds: 5
```

Путь:

```text
/etc/filin-agent/config.yml
```

---

## 11. systemd service агента

Пример:

```ini
[Unit]
Description=N Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/filin-agent --config /etc/filin-agent/config.yml
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

На старте можно запускать от root, потому что агенту нужно читать Docker, порты, firewall и systemd.

Позже можно разделить права и сделать более безопасную модель.

---

## 12. Что делает install script

Install script должен:

```text
1. Проверить, что запущен через root/sudo
2. Определить OS
3. Определить architecture: amd64/arm64
4. Проверить наличие systemd
5. Скачать agent binary
6. Положить binary в /usr/local/bin/filin-agent
7. Создать /etc/filin-agent/
8. Выполнить enroll через Master API
9. Сохранить config.yml
10. Создать systemd unit
11. Выполнить systemctl daemon-reload
12. Включить автозапуск
13. Запустить agent
14. Показать статус установки
```

---

## 13. Что агент собирает

### 13.1 System metrics

Agent собирает:

- hostname;
- uptime;
- OS;
- kernel;
- architecture;
- CPU model;
- CPU cores;
- CPU usage;
- RAM total;
- RAM used;
- RAM free;
- swap;
- disk total;
- disk used;
- disk free;
- load average;
- network RX/TX;
- public IP;
- local IP addresses.

---

### 13.2 Docker

Agent собирает:

- список контейнеров;
- container ID;
- name;
- image;
- status;
- restart count;
- created at;
- started at;
- exposed ports;
- published ports;
- networks;
- mounts;
- labels;
- CPU usage;
- RAM usage;
- network usage;
- healthcheck status.

Команды/источники:

```bash
docker ps --format json
docker stats --no-stream
docker inspect
docker network ls
docker volume ls
```

Лучше работать не через shell-команды, а через Docker API.

---

### 13.3 Open ports

Agent собирает открытые порты:

```bash
ss -tulpn
```

Сохранять:

- protocol;
- port;
- listen address;
- process name;
- PID;
- user;
- related container, если удалось связать;
- exposed/public status.

Пример:

```json
{
  "port": 443,
  "protocol": "tcp",
  "listen_ip": "0.0.0.0",
  "process": "caddy",
  "pid": 1234,
  "container_name": "caddy"
}
```

---

### 13.4 Firewall

Agent может собирать:

```bash
ufw status
iptables -S
nft list ruleset
```

На MVP можно начать с UFW и открытых портов.

Позже добавить iptables/nftables.

---

### 13.5 Systemd services

Agent может собирать:

```bash
systemctl list-units --type=service --state=running
systemctl list-units --type=service --state=failed
```

Полезно для:

- caddy;
- nginx;
- postgresql;
- redis;
- telegram bots;
- собственных сервисов;
- xray/sing-box;
- custom daemons.

---

## 14. Snapshots

Snapshot — полный снимок состояния ноды в конкретный момент времени.

Пример snapshot:

```json
{
  "node_id": "node_01HXYZ",
  "timestamp": "2026-04-25T12:00:00Z",
  "system": {
    "hostname": "estonia",
    "os": "Ubuntu 24.04",
    "arch": "amd64",
    "uptime_seconds": 184000
  },
  "metrics": {
    "cpu_percent": 13.4,
    "ram_used_mb": 742,
    "ram_total_mb": 2048,
    "disk_used_gb": 18.2,
    "disk_total_gb": 40,
    "load_1": 0.31,
    "load_5": 0.27,
    "load_15": 0.22
  },
  "ports": [
    {
      "port": 443,
      "protocol": "tcp",
      "listen_ip": "0.0.0.0",
      "process": "caddy"
    }
  ],
  "containers": [
    {
      "id": "abc123",
      "name": "panel-panel-1",
      "image": "mgb-panel:dev",
      "status": "running",
      "ports": ["8443:8443"],
      "cpu_percent": 2.1,
      "ram_mb": 128
    }
  ]
}
```

---

## 15. Heartbeat

Heartbeat — лёгкий сигнал, что нода жива.

Agent отправляет heartbeat чаще, чем полный snapshot.

Пример:

```json
{
  "node_id": "node_01HXYZ",
  "timestamp": "2026-04-25T12:00:00Z",
  "agent_version": "0.1.0",
  "status": "online"
}
```

Рекомендуемые интервалы:

```text
Heartbeat: каждые 5-10 секунд
Light metrics: каждые 10-15 секунд
Full snapshot: каждые 30-60 секунд
Heavy inventory: каждые 5-15 минут
```

---

## 16. Задачи и команды

Master может отправлять Agent задачи.

Но важно: не делать свободный root shell из браузера.

Плохо:

```text
run_any_command_as_root
```

Правильно:

```text
container.restart
container.stop
container.start
container.logs
service.restart
docker.compose.pull
docker.compose.up
docker.compose.down
system.reboot
```

Каждая команда должна быть типизирована и ограничена.

---

## 17. Пример задачи

Master создаёт задачу:

```json
{
  "id": "task_123",
  "node_id": "node_01HXYZ",
  "type": "container.restart",
  "payload": {
    "container_id": "abc123"
  },
  "status": "pending"
}
```

Agent получает задачу, выполняет и возвращает результат:

```json
{
  "task_id": "task_123",
  "status": "success",
  "result": {
    "message": "Container restarted"
  }
}
```

---

## 18. Способы связи для задач

### Вариант 1: polling

Agent каждые несколько секунд спрашивает Master:

```text
GET /api/agent/tasks
```

Плюсы:

- проще реализовать;
- стабильнее для MVP;
- не нужен постоянный WebSocket;
- проще отлаживать.

Минусы:

- не совсем real-time;
- есть задержка 1-5 секунд;
- чуть больше запросов.

---

### Вариант 2: WebSocket

Agent держит постоянное подключение:

```text
Agent -> WSS -> Master
```

Master может сразу отправить задачу.

Плюсы:

- real-time;
- удобно для логов;
- удобно для streaming;
- удобно для live terminal-like функций.

Минусы:

- сложнее реализация;
- нужно аккуратно обрабатывать reconnect;
- сложнее масштабировать Master.

---

### Рекомендация

Для MVP:

```text
Polling
```

Позже:

```text
WebSocket для live-логов и быстрых команд
```

---

## 19. API Master

### 19.1 Agent enrollment

```http
POST /api/agent/enroll
```

Request:

```json
{
  "enroll_token": "fna_enroll_xxx",
  "hostname": "estonia",
  "public_ip": "1.2.3.4",
  "os": "Ubuntu 24.04",
  "arch": "amd64",
  "agent_version": "0.1.0"
}
```

Response:

```json
{
  "node_id": "node_01HXYZ",
  "agent_token": "fna_agent_xxx",
  "config": {
    "collect_interval_seconds": 10,
    "task_poll_interval_seconds": 5
  }
}
```

---

### 19.2 Heartbeat

```http
POST /api/agent/heartbeat
Authorization: Bearer fna_agent_xxx
```

---

### 19.3 Snapshot

```http
POST /api/agent/snapshot
Authorization: Bearer fna_agent_xxx
```

---

### 19.4 Get tasks

```http
GET /api/agent/tasks
Authorization: Bearer fna_agent_xxx
```

---

### 19.5 Send task result

```http
POST /api/agent/tasks/{task_id}/result
Authorization: Bearer fna_agent_xxx
```

---

## 20. Web UI

Главный интерфейс должен быть не просто мониторингом, а инвентаризацией.

---

### 20.1 Главная страница

На главной:

- количество VPS;
- online/offline;
- общий CPU/RAM/Disk;
- алерты;
- последние события;
- ноды с проблемами;
- новые открытые порты;
- упавшие контейнеры.

Пример:

```text
Infrastructure Overview

Nodes: 5
Online: 4
Offline: 1
Containers: 38
Running: 35
Warnings: 3
Critical: 1
```

---

### 20.2 Страница нод

Карточки VPS:

```text
Estonia VPS
Online
IP: 1.2.3.4
CPU: 13%
RAM: 742MB / 2GB
Disk: 18GB / 40GB
Containers: 7 running / 1 stopped
Open ports: 22, 80, 443, 8443
Last seen: 3 seconds ago
```

Фильтры:

- по группе;
- по статусу;
- по provider;
- по location;
- по tags;
- по открытым портам;
- по наличию Docker;
- по проблемам.

---

### 20.3 Страница конкретной ноды

Разделы:

```text
Overview
Metrics
Docker
Ports
Firewall
Services
Tasks
Events
Logs
Settings
```

---

### 20.4 Docker UI

Для контейнеров показывать:

- name;
- image;
- status;
- uptime;
- ports;
- CPU;
- RAM;
- restart count;
- networks;
- mounts;
- healthcheck;
- logs button;
- restart button;
- stop/start button.

---

### 20.5 Ports UI

Порты показывать отдельно и понятно:

```text
Port  Protocol  Listen IP   Process       Container       Status
22    tcp       0.0.0.0     sshd          -               expected
80    tcp       0.0.0.0     caddy         caddy           expected
443   tcp       0.0.0.0     caddy         caddy           expected
8443  tcp       0.0.0.0     docker-proxy  panel-panel-1   warning
```

Самая полезная функция:

```text
Алерт, если открылся новый неожиданный порт
```

---

### 20.6 Projects view

Позже нужно добавить не только серверы, но и проекты.

Пример:

```text
Project: KLMsecurity.xyz
  Node: Estonia VPS
  Services:
    frontend: running
    api: running
    caddy: running
  Domains:
    klmsecurity.xyz
  Ports:
    80, 443
```

Проекты позволяют видеть инфраструктуру не как список контейнеров, а как понятные сущности.

---

## 21. База данных

### 21.1 nodes

```sql
CREATE TABLE nodes (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    hostname TEXT,
    public_ip INET,
    os TEXT,
    arch TEXT,
    provider TEXT,
    location TEXT,
    group_name TEXT,
    tags JSONB NOT NULL DEFAULT '[]',
    agent_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ
);
```

---

### 21.2 node_enroll_tokens

```sql
CREATE TABLE node_enroll_tokens (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES nodes(id),
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 21.3 node_credentials

```sql
CREATE TABLE node_credentials (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES nodes(id),
    token_hash TEXT NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 21.4 node_metrics

```sql
CREATE TABLE node_metrics (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES nodes(id),
    cpu_percent DOUBLE PRECISION,
    ram_used_mb BIGINT,
    ram_total_mb BIGINT,
    disk_used_gb DOUBLE PRECISION,
    disk_total_gb DOUBLE PRECISION,
    load_1 DOUBLE PRECISION,
    load_5 DOUBLE PRECISION,
    load_15 DOUBLE PRECISION,
    network_rx_bytes BIGINT,
    network_tx_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 21.5 docker_containers

```sql
CREATE TABLE docker_containers (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES nodes(id),
    container_id TEXT NOT NULL,
    name TEXT NOT NULL,
    image TEXT,
    status TEXT,
    state TEXT,
    ports JSONB NOT NULL DEFAULT '[]',
    networks JSONB NOT NULL DEFAULT '[]',
    mounts JSONB NOT NULL DEFAULT '[]',
    labels JSONB NOT NULL DEFAULT '{}',
    cpu_percent DOUBLE PRECISION,
    ram_mb DOUBLE PRECISION,
    restart_count INTEGER,
    health_status TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(node_id, container_id)
);
```

---

### 21.6 open_ports

```sql
CREATE TABLE open_ports (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES nodes(id),
    protocol TEXT NOT NULL,
    port INTEGER NOT NULL,
    listen_ip TEXT,
    process_name TEXT,
    pid INTEGER,
    user_name TEXT,
    container_name TEXT,
    is_expected BOOLEAN NOT NULL DEFAULT false,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(node_id, protocol, port, listen_ip)
);
```

---

### 21.7 tasks

```sql
CREATE TABLE tasks (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES nodes(id),
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
```

---

### 21.8 events

```sql
CREATE TABLE events (
    id UUID PRIMARY KEY,
    node_id UUID REFERENCES nodes(id),
    severity TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 22. Безопасность

### 22.1 Токены

Нужны два типа токенов:

```text
enroll token — одноразовый для установки
agent token  — постоянный для работы агента
```

Правила:

- хранить токены в базе только как hash;
- показывать raw token только один раз;
- agent token можно отозвать;
- у каждой ноды свой agent token;
- нельзя использовать один общий token на все ноды.

---

### 22.2 Разделение прав

Не нужно давать агенту возможность выполнять любую команду.

Нужно сделать whitelist-команды:

```text
container.restart
container.stop
container.start
container.logs
service.restart
docker.compose.pull
docker.compose.up
```

Каждая команда должна валидироваться.

---

### 22.3 Audit log

Все действия из панели должны писаться в audit log:

```text
кто сделал
когда сделал
на какой ноде
какую команду
с каким payload
какой результат
```

Особенно:

- restart;
- stop;
- delete;
- compose up/down;
- token revoke;
- node delete;
- user login;
- settings change.

---

### 22.4 Защита Master

Master — самая важная часть.

Нужно:

- HTTPS через Caddy;
- закрыть лишние порты;
- включить firewall;
- включить 2FA для пользователя;
- хранить секреты в env/secrets;
- делать backup PostgreSQL;
- ограничить доступ к admin UI;
- rate limit на login и enroll endpoints.

---

## 23. Алерты

Минимальные алерты:

```text
Node offline
Node back online
CPU > 85%
RAM > 85%
Disk > 90%
Container stopped
Container unhealthy
New unexpected open port
Docker unavailable
Agent version outdated
Failed systemd service
```

Особенно важный алерт:

```text
New unexpected open port
```

Для VPS-инфраструктуры это очень полезно, потому что открытый порт часто означает:

- забытый dev-сервис;
- случайно опубликованный Docker-порт;
- неправильно настроенный compose;
- потенциальную дыру безопасности.

---

## 24. Expected ports

Нужно дать возможность помечать порты как ожидаемые.

Пример:

```text
22/tcp   expected: SSH
80/tcp   expected: HTTP
443/tcp  expected: HTTPS
8443/tcp expected: MGB Panel dev
```

Если появляется новый порт, которого нет в expected list, создаётся warning.

---

## 25. MVP v1

Первая версия должна быть максимально простой.

### Backend

- FastAPI;
- PostgreSQL;
- JWT login;
- endpoint для enroll;
- endpoint для heartbeat;
- endpoint для snapshot;
- endpoint для списка нод;
- endpoint для карточки ноды.

### Agent

- установка через copy-paste команду;
- systemd service;
- enroll;
- heartbeat;
- сбор CPU/RAM/Disk;
- сбор Docker containers;
- сбор open ports;
- отправка snapshot.

### UI

- login;
- список VPS;
- карточка VPS;
- CPU/RAM/Disk;
- Docker containers;
- Open ports;
- last seen;
- online/offline.

---

## 26. MVP v2

Добавить управление:

- restart container;
- stop container;
- start container;
- view container logs;
- restart systemd service;
- task history;
- events page;
- basic alerts.

---

## 27. MVP v3

Добавить проекты:

- project entity;
- привязка контейнеров к проектам;
- привязка доменов;
- привязка ports;
- project overview;
- health score проекта.

Пример:

```text
Project: VPN Panel
Nodes:
  Estonia VPS
Services:
  panel: running
  postgres: running
  caddy: running
Domains:
  vpn.example.com
Ports:
  443
```

---

## 28. MVP v4

Добавить advanced-функции:

- live logs через WebSocket;
- realtime metrics;
- agent auto-update;
- remote config update;
- labels/tags;
- backup status;
- docker compose stack detection;
- firewall rules parser;
- notification integrations;
- Telegram alerts;
- Discord alerts;
- email alerts.

---

## 29. Agent auto-update

Позже можно добавить обновление агента.

Сценарий:

```text
1. Master видит, что agent_version устарел
2. UI показывает кнопку "Update agent"
3. Master создаёт task: agent.update
4. Agent скачивает новую версию
5. Проверяет checksum
6. Заменяет binary
7. Перезапускает systemd service
8. Отправляет новый heartbeat
```

Важно:

- проверять checksum;
- иметь rollback;
- не обновлять все ноды одновременно;
- показывать статус обновления.

---

## 30. Naming

Возможные названия:

```text
N
FilinAgent
FilinPanel
```

Или:

```text
OwlControl
OwlAgent
OwlPanel
```

Рабочий вариант:

```text
N
```

Компоненты:

```text
filin-master
filin-agent
filin-panel
```

---

## 31. Структура репозитория

Вариант monorepo:

```text
filin-control/
  apps/
    master-api/
      app/
      migrations/
      Dockerfile
    web-panel/
      src/
      Dockerfile
    agent/
      cmd/
      internal/
      Dockerfile
  deploy/
    docker-compose.yml
    caddy/
    systemd/
  scripts/
    install-agent.sh
  docs/
    architecture.md
    api.md
    security.md
  README.md
```

---

## 32. Пример Docker Compose для Master

```yaml
services:
  api:
    build: ./apps/master-api
    environment:
      DATABASE_URL: postgres://filin:filin@postgres:5432/filin
      REDIS_URL: redis://redis:6379/0
      JWT_SECRET: change_me
    depends_on:
      - postgres
      - redis

  web:
    build: ./apps/web-panel
    depends_on:
      - api

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: filin
      POSTGRES_PASSWORD: filin
      POSTGRES_DB: filin
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine

  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/caddy/Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api
      - web

volumes:
  postgres_data:
  caddy_data:
  caddy_config:
```

---

## 33. Пример Caddyfile

```caddyfile
panel.example.com {
    reverse_proxy /api/* api:8000
    reverse_proxy web:3000
}
```

---

## 34. Что важно не усложнять на старте

Не надо сразу делать:

- Kubernetes;
- Prometheus;
- Grafana;
- полноценный log management;
- произвольный terminal в браузере;
- Web3/P2P;
- сложную систему ролей;
- auto-healing;
- плагины;
- marketplace;
- multi-tenant SaaS.

Сначала нужно сделать простое ядро:

```text
вижу все VPS
вижу ресурсы
вижу контейнеры
вижу порты
могу добавить новую ноду одной командой
```

---

## 35. Главные продуктовые фичи

### 35.1 Add Node UX

Главная фича:

```text
Нажал "Add node" → получил команду → вставил на VPS → нода появилась в панели
```

Это должно быть сделано максимально красиво.

---

### 35.2 Порты

Вторая главная фича:

```text
Видеть все открытые порты на всех VPS
```

И особенно:

```text
увидеть неожиданный новый порт
```

---

### 35.3 Docker inventory

Третья главная фича:

```text
Видеть все контейнеры на всех VPS
```

Не через SSH, не руками, а из одной панели.

---

### 35.4 Контекст проектов

Четвёртая важная фича:

```text
Понимать, какой контейнер относится к какому проекту
```

Без этого панель быстро превратится в свалку контейнеров.

---

## 36. Пример первого roadmap

### Week 1

- создать FastAPI проект;
- создать PostgreSQL schema;
- сделать auth;
- сделать создание pending-node;
- сделать генерацию enroll token;
- сделать install command в UI/API.

### Week 2

- написать Go agent;
- сделать enroll;
- сделать config.yml;
- сделать systemd unit;
- сделать install script.

### Week 3

- сбор CPU/RAM/Disk;
- сбор open ports;
- сбор Docker ps;
- отправка snapshot;
- отображение нод в UI.

### Week 4

- Docker containers UI;
- Ports UI;
- online/offline;
- events;
- alert на новый порт.

### Week 5+

- task system;
- restart container;
- logs;
- project mapping;
- Telegram alerts;
- WebSocket live updates.

---

## 37. Минимальная первая цель

Самая первая рабочая версия считается успешной, если можно:

```text
1. Поднять Master на одной VPS
2. Нажать Add node
3. Получить install command
4. Вставить команду на другой VPS
5. Увидеть ноду online
6. Увидеть CPU/RAM/Disk
7. Увидеть Docker containers
8. Увидеть open ports
```

Если это работает — основа проекта уже есть.

---

## 38. Финальное решение

Архитектура проекта:

```text
Центральный Master + агенты на каждой VPS
```

Главный принцип:

```text
Agent сам подключается к Master и отправляет данные наружу
```

Onboarding:

```text
Master генерирует одноразовую install-команду для новой ноды
```

Безопасность:

```text
одноразовый enroll token → постоянный agent token → whitelist-команды
```

Первый фокус:

```text
инвентаризация серверов, портов, контейнеров и ресурсов
```

Второй фокус:

```text
управление контейнерами и алерты
```

Третий фокус:

```text
проекты, домены, сервисы и удобная карта инфраструктуры
```

---

## 39. Короткое резюме

N — это личная панель управления VPS.

Она должна отвечать на вопросы:

```text
Где что запущено?
Какие порты открыты?
Какие контейнеры работают?
Какая VPS перегружена?
Какая VPS offline?
Какой проект где лежит?
Что изменилось недавно?
Что сломалось?
```

Правильная основа:

```text
Master + Agent + PostgreSQL + Web UI
```

Это не просто мониторинг. Это **единая карта всей инфраструктуры**.
