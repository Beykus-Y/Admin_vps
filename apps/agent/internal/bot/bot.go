package bot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/filincontrol/agent/internal/client"
)

// ─── Telegram API types ──────────────────────────────────────────────────────

type tgUpdate struct {
	UpdateID      int         `json:"update_id"`
	Message       *tgMessage  `json:"message"`
	CallbackQuery *tgCallback `json:"callback_query"`
}

type tgMessage struct {
	MessageID int    `json:"message_id"`
	Chat      tgChat `json:"chat"`
	Text      string `json:"text"`
}

type tgChat struct {
	ID int64 `json:"id"`
}

type tgCallback struct {
	ID      string     `json:"id"`
	From    tgUser     `json:"from"`
	Message *tgMessage `json:"message"`
	Data    string     `json:"data"`
}

type tgUser struct {
	ID int64 `json:"id"`
}

type tgResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
}

type tgSentMessage struct {
	MessageID int `json:"message_id"`
}

// ─── Inline keyboard ─────────────────────────────────────────────────────────

type InlineButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data,omitempty"`
}

type InlineKeyboard struct {
	InlineKeyboard [][]InlineButton `json:"inline_keyboard"`
}

func row(btns ...InlineButton) []InlineButton { return btns }

func kb(rows ...[]InlineButton) *InlineKeyboard {
	return &InlineKeyboard{InlineKeyboard: rows}
}

// ─── Container cache ─────────────────────────────────────────────────────────

type contCacheEntry struct {
	items     []client.BotContainer
	fetchedAt time.Time
}

// ─── Bot ─────────────────────────────────────────────────────────────────────

type Bot struct {
	token          string
	allowedChatIDs map[int64]struct{}
	masterClient   *client.Client
	httpClient     *http.Client
	chartClient    *http.Client
	stopCh         chan struct{}
	mu             sync.Mutex
	running        bool

	contCacheMu sync.RWMutex
	contCache   map[string]contCacheEntry // nodeID → containers
}

func New(token string, allowedChatIDs []int64, masterClient *client.Client) *Bot {
	allowed := make(map[int64]struct{}, len(allowedChatIDs))
	for _, id := range allowedChatIDs {
		allowed[id] = struct{}{}
	}
	return &Bot{
		token:          token,
		allowedChatIDs: allowed,
		masterClient:   masterClient,
		httpClient:     &http.Client{Timeout: 40 * time.Second},
		chartClient:    &http.Client{Timeout: 20 * time.Second},
		contCache:      make(map[string]contCacheEntry),
	}
}

func (b *Bot) Start() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.running {
		return
	}
	b.stopCh = make(chan struct{})
	b.running = true
	go b.run()
	log.Print("telegram bot runner started")
}

func (b *Bot) Stop() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.running {
		return
	}
	close(b.stopCh)
	b.running = false
	log.Print("telegram bot runner stopped")
}

func (b *Bot) IsRunning() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.running
}

// SendNotificationToChats is called from main.go when a bot.notify task arrives.
func (b *Bot) SendNotificationToChats(chatIDs []int64, text, parseMode string) {
	if parseMode == "" {
		parseMode = "HTML"
	}
	for _, chatID := range chatIDs {
		if err := b.sendText(chatID, text, parseMode, nil); err != nil {
			log.Printf("bot notify chat %d: %v", chatID, err)
		}
	}
}

// ─── Main loop ───────────────────────────────────────────────────────────────

func (b *Bot) run() {
	offset := 0
	for {
		select {
		case <-b.stopCh:
			return
		default:
		}
		updates, err := b.getUpdates(offset, 30)
		if err != nil {
			log.Printf("telegram getUpdates: %v", err)
			select {
			case <-b.stopCh:
				return
			case <-time.After(5 * time.Second):
				continue
			}
		}
		for _, upd := range updates {
			offset = upd.UpdateID + 1
			go b.handleUpdate(upd)
		}
	}
}

func (b *Bot) isAllowed(chatID int64) bool {
	if len(b.allowedChatIDs) == 0 {
		return true
	}
	_, ok := b.allowedChatIDs[chatID]
	return ok
}

func (b *Bot) handleUpdate(upd tgUpdate) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("bot panic: %v", r)
		}
	}()
	if upd.Message != nil && b.isAllowed(upd.Message.Chat.ID) {
		b.handleMessage(upd.Message.Chat.ID, strings.TrimSpace(upd.Message.Text))
		return
	}
	if upd.CallbackQuery != nil && b.isAllowed(upd.CallbackQuery.From.ID) {
		b.handleCallback(*upd.CallbackQuery)
	}
}

// ─── Message handlers ────────────────────────────────────────────────────────

func (b *Bot) handleMessage(chatID int64, text string) {
	parts := strings.Fields(text)
	if len(parts) == 0 {
		return
	}
	cmd := strings.ToLower(parts[0])
	if idx := strings.Index(cmd, "@"); idx != -1 {
		cmd = cmd[:idx]
	}
	switch cmd {
	case "/start", "/help":
		b.cmdHelp(chatID)
	case "/nodes", "/status":
		b.cmdNodes(chatID, 0)
	case "/alerts":
		b.cmdAlerts(chatID, 0)
	case "/logs":
		if len(parts) >= 3 {
			b.doLogs(chatID, parts[1], strings.Join(parts[2:], " "))
		} else {
			b.sendHTML(chatID, "Использование: <code>/logs &lt;нода&gt; &lt;контейнер&gt;</code>")
		}
	default:
		b.sendHTML(chatID, "Неизвестная команда. /help — список команд.")
	}
}

func (b *Bot) cmdHelp(chatID int64) {
	text := "🤖 <b>FilinControl Bot</b>\n\n" +
		"<b>Команды:</b>\n" +
		"/nodes — статус нод\n" +
		"/alerts — активные алерты\n" +
		"/logs &lt;нода&gt; &lt;контейнер&gt; — логи контейнера\n" +
		"/help — эта справка"
	keyboard := kb(
		row(
			InlineButton{Text: "📊 Ноды", CallbackData: "nodes"},
			InlineButton{Text: "🚨 Алерты", CallbackData: "alerts"},
		),
	)
	b.sendHTML(chatID, text)
	_ = keyboard // menu shown inline on /nodes and /alerts
}

func (b *Bot) cmdNodes(chatID int64, editMsgID int) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	nodes, err := b.masterClient.GetBotNodes(ctx)
	if err != nil {
		b.replyOrEdit(chatID, editMsgID, "❌ Ошибка: "+e(err.Error()), nil)
		return
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "<b>Ноды (%d):</b>\n", len(nodes))
	for _, n := range nodes {
		fmt.Fprintf(&sb, "\n%s <b>%s</b> — <i>%s</i>", nodeIcon(n.Status), e(n.Name), n.Status)
		if n.PublicIP != "" {
			fmt.Fprintf(&sb, "\n   <code>%s</code>", e(n.PublicIP))
		}
	}

	var btnRows [][]InlineButton
	row1 := make([]InlineButton, 0, 3)
	for i, n := range nodes {
		row1 = append(row1, InlineButton{Text: nodeIcon(n.Status) + " " + n.Name, CallbackData: "n:" + n.ID})
		if len(row1) == 3 || i == len(nodes)-1 {
			btnRows = append(btnRows, row1)
			row1 = nil
		}
	}
	btnRows = append(btnRows, row(InlineButton{Text: "🔄 Обновить", CallbackData: "nodes"}))
	keyboard := &InlineKeyboard{InlineKeyboard: btnRows}

	b.replyOrEdit(chatID, editMsgID, sb.String(), keyboard)
}

func (b *Bot) cmdAlerts(chatID int64, editMsgID int) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	alerts, err := b.masterClient.GetBotAlerts(ctx)
	if err != nil {
		b.replyOrEdit(chatID, editMsgID, "❌ Ошибка: "+e(err.Error()), nil)
		return
	}
	if len(alerts) == 0 {
		b.replyOrEdit(chatID, editMsgID, "✅ <b>Активных алертов нет</b>", kb(
			row(InlineButton{Text: "🔄 Обновить", CallbackData: "alerts"}),
		))
		return
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "🚨 <b>Активных алертов: %d</b>\n", len(alerts))
	var ackBtns []InlineButton
	for i, a := range alerts {
		icon := severityIcon(a.Severity)
		ackMark := ""
		if a.Acknowledged {
			ackMark = " ✅"
		}
		nodePart := ""
		if a.NodeName != "" {
			nodePart = fmt.Sprintf(" [<b>%s</b>]", e(a.NodeName))
		}
		fmt.Fprintf(&sb, "\n%s%s%s\n<i>%s</i>", icon, nodePart, ackMark, e(a.Message))

		if !a.Acknowledged {
			label := fmt.Sprintf("✅ #%d", i+1)
			cbData := "aa:" + a.ID
			if len(cbData) <= 64 {
				ackBtns = append(ackBtns, InlineButton{Text: label, CallbackData: cbData})
			}
		}
	}

	var btnRows [][]InlineButton
	if len(ackBtns) > 0 {
		for i := 0; i < len(ackBtns); i += 3 {
			end := i + 3
			if end > len(ackBtns) {
				end = len(ackBtns)
			}
			btnRows = append(btnRows, ackBtns[i:end])
		}
	}
	btnRows = append(btnRows, row(InlineButton{Text: "🔄 Обновить", CallbackData: "alerts"}))
	b.replyOrEdit(chatID, editMsgID, sb.String(), &InlineKeyboard{InlineKeyboard: btnRows})
}

// ─── Callback handlers ───────────────────────────────────────────────────────

func (b *Bot) handleCallback(cb tgCallback) {
	_ = b.answerCallback(cb.ID, "")
	data := cb.Data
	chatID := cb.From.ID
	msgID := 0
	if cb.Message != nil {
		msgID = cb.Message.MessageID
	}

	switch {
	case data == "nodes":
		b.cmdNodes(chatID, msgID)
	case data == "alerts":
		b.cmdAlerts(chatID, msgID)
	case strings.HasPrefix(data, "n:"):
		b.cbNodeDetail(chatID, msgID, data[2:])
	case strings.HasPrefix(data, "nc:"):
		b.cbNodeContainers(chatID, msgID, data[3:])
	case strings.HasPrefix(data, "nch:"):
		b.cbNodeChart(chatID, data[4:])
	case strings.HasPrefix(data, "cr:"):
		rest := data[3:]
		sep := strings.LastIndex(rest, ":")
		if sep > 0 {
			b.cbContainerRestart(chatID, msgID, rest[:sep], rest[sep+1:])
		}
	case strings.HasPrefix(data, "lg:"):
		rest := data[3:]
		sep := strings.LastIndex(rest, ":")
		if sep > 0 {
			b.cbContainerLogs(chatID, rest[:sep], rest[sep+1:])
		}
	case strings.HasPrefix(data, "aa:"):
		b.cbAlertAck(chatID, msgID, data[3:])
	}
}

func (b *Bot) cbNodeDetail(chatID int64, msgID int, nodeID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	d, err := b.masterClient.GetBotNodeDetail(ctx, nodeID)
	if err != nil {
		b.replyOrEdit(chatID, msgID, "❌ "+e(err.Error()), nil)
		return
	}
	text := nodeDetailText(d)
	keyboard := kb(
		row(
			InlineButton{Text: "📈 График", CallbackData: "nch:" + nodeID},
			InlineButton{Text: "🐳 Контейнеры", CallbackData: "nc:" + nodeID},
		),
		row(InlineButton{Text: "◀ Ноды", CallbackData: "nodes"}),
	)
	b.replyOrEdit(chatID, msgID, text, keyboard)
}

func (b *Bot) cbNodeChart(chatID int64, nodeID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	_ = b.sendAction(chatID, "upload_photo")

	imgBytes, nodeName, err := b.generateMetricsChart(ctx, nodeID)
	if err != nil {
		b.sendHTML(chatID, "❌ Не удалось построить график: "+e(err.Error()))
		return
	}

	caption := fmt.Sprintf("📈 <b>%s</b> — CPU &amp; RAM (2h)", e(nodeName))
	keyboard := kb(
		row(
			InlineButton{Text: "🔄 Обновить", CallbackData: "nch:" + nodeID},
			InlineButton{Text: "◀ Нода", CallbackData: "n:" + nodeID},
		),
	)
	if err := b.sendPhoto(chatID, imgBytes, caption, keyboard); err != nil {
		log.Printf("bot sendPhoto: %v", err)
	}
}

func (b *Bot) cbNodeContainers(chatID int64, msgID int, nodeID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	containers, err := b.masterClient.GetBotNodeContainers(ctx, nodeID)
	if err != nil {
		b.replyOrEdit(chatID, msgID, "❌ "+e(err.Error()), nil)
		return
	}

	// Cache for callback lookups
	b.contCacheMu.Lock()
	b.contCache[nodeID] = contCacheEntry{items: containers, fetchedAt: time.Now()}
	b.contCacheMu.Unlock()

	if len(containers) == 0 {
		b.replyOrEdit(chatID, msgID, "🐳 Контейнеров нет.", kb(
			row(InlineButton{Text: "◀ Назад", CallbackData: "n:" + nodeID}),
		))
		return
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "🐳 <b>Контейнеры (%d):</b>\n", len(containers))
	for _, c := range containers {
		icon := containerIcon(c.State)
		ramStr := ""
		if c.RAMMB > 0 {
			ramStr = fmt.Sprintf(" · %.0f MB", c.RAMMB)
		}
		cpuStr := ""
		if c.CPUPercent > 0 {
			cpuStr = fmt.Sprintf(" · %.1f%%", c.CPUPercent)
		}
		fmt.Fprintf(&sb, "\n%s <b>%s</b>  <i>%s</i>%s%s",
			icon, e(c.Name), e(c.State), cpuStr, ramStr)
		if c.Image != "" {
			fmt.Fprintf(&sb, "\n   <code>%s</code>", e(c.Image))
		}
	}

	var btnRows [][]InlineButton
	restartRow := make([]InlineButton, 0, 3)
	logsRow := make([]InlineButton, 0, 3)
	for _, c := range containers {
		name20 := c.Name
		if len(name20) > 20 {
			name20 = name20[:20]
		}
		cbRestart := "cr:" + nodeID + ":" + name20
		cbLogs := "lg:" + nodeID + ":" + name20
		if len(cbRestart) <= 64 {
			restartRow = append(restartRow, InlineButton{Text: "🔄 " + c.Name, CallbackData: cbRestart})
		}
		if len(cbLogs) <= 64 {
			logsRow = append(logsRow, InlineButton{Text: "📋 " + c.Name, CallbackData: cbLogs})
		}
		if len(restartRow) == 3 {
			btnRows = append(btnRows, restartRow)
			restartRow = nil
		}
	}
	if len(restartRow) > 0 {
		btnRows = append(btnRows, restartRow)
	}
	if len(logsRow) > 0 {
		for i := 0; i < len(logsRow); i += 3 {
			end := i + 3
			if end > len(logsRow) {
				end = len(logsRow)
			}
			btnRows = append(btnRows, logsRow[i:end])
		}
	}
	btnRows = append(btnRows, row(
		InlineButton{Text: "🔄 Обновить", CallbackData: "nc:" + nodeID},
		InlineButton{Text: "◀ Нода", CallbackData: "n:" + nodeID},
	))
	b.replyOrEdit(chatID, msgID, sb.String(), &InlineKeyboard{InlineKeyboard: btnRows})
}

func (b *Bot) cbContainerRestart(chatID int64, msgID int, nodeID, namePrefix string) {
	contID := b.lookupContainerID(nodeID, namePrefix)
	if contID == "" {
		b.replyOrEdit(chatID, msgID, "❌ Контейнер не найден в кэше. Обновите список.", kb(
			row(InlineButton{Text: "◀ Контейнеры", CallbackData: "nc:" + nodeID}),
		))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := b.masterClient.CreateBotTask(ctx, nodeID, client.BotCreateTaskRequest{
		Type:    "container.restart",
		Payload: map[string]any{"container_id": contID},
	})
	if err != nil {
		b.replyOrEdit(chatID, msgID, "❌ Ошибка: "+e(err.Error()), kb(
			row(InlineButton{Text: "◀ Контейнеры", CallbackData: "nc:" + nodeID}),
		))
		return
	}
	b.replyOrEdit(chatID, msgID,
		fmt.Sprintf("🔄 Задача restart <b>%s</b> создана", e(namePrefix)),
		kb(row(InlineButton{Text: "◀ Контейнеры", CallbackData: "nc:" + nodeID})),
	)
}

func (b *Bot) cbContainerLogs(chatID int64, nodeID, namePrefix string) {
	contID := b.lookupContainerID(nodeID, namePrefix)
	if contID == "" {
		b.sendHTML(chatID, "❌ Контейнер не найден в кэше. Сначала откройте список контейнеров.")
		return
	}
	b.doLogsByContainerID(chatID, nodeID, namePrefix, contID)
}

func (b *Bot) doLogs(chatID int64, nodeName, contName string) {
	// Find node by name
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	nodes, err := b.masterClient.GetBotNodes(ctx)
	if err != nil {
		b.sendHTML(chatID, "❌ "+e(err.Error()))
		return
	}
	var nodeID string
	for _, n := range nodes {
		if strings.EqualFold(n.Name, nodeName) {
			nodeID = n.ID
			break
		}
	}
	if nodeID == "" {
		b.sendHTML(chatID, fmt.Sprintf("❌ Нода <b>%s</b> не найдена.", e(nodeName)))
		return
	}

	// Fetch containers to find container_id
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	containers, err := b.masterClient.GetBotNodeContainers(ctx2, nodeID)
	if err != nil {
		b.sendHTML(chatID, "❌ "+e(err.Error()))
		return
	}
	var contID string
	for _, c := range containers {
		if strings.EqualFold(c.Name, contName) {
			contID = c.ContainerID
			break
		}
	}
	if contID == "" {
		b.sendHTML(chatID, fmt.Sprintf("❌ Контейнер <b>%s</b> не найден.", e(contName)))
		return
	}
	b.doLogsByContainerID(chatID, nodeID, contName, contID)
}

func (b *Bot) doLogsByContainerID(chatID int64, nodeID, contName, contID string) {
	_ = b.sendAction(chatID, "typing")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	task, err := b.masterClient.CreateBotTask(ctx, nodeID, client.BotCreateTaskRequest{
		Type:    "container.logs",
		Payload: map[string]any{"container_id": contID, "tail": float64(80)},
	})
	if err != nil {
		b.sendHTML(chatID, "❌ "+e(err.Error()))
		return
	}

	// Poll for result
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(1500 * time.Millisecond)
		t, err := b.masterClient.GetBotTask(ctx, task.ID)
		if err != nil {
			continue
		}
		if t.Status == "success" {
			stdout, _ := t.Result["stdout"].(string)
			stderr, _ := t.Result["stderr"].(string)
			out := stdout
			if out == "" {
				out = stderr
			}
			if out == "" {
				out = "(нет вывода)"
			}
			// Telegram message limit is 4096 chars; truncate from end
			if len(out) > 3800 {
				out = "…\n" + out[len(out)-3800:]
			}
			text := fmt.Sprintf("📋 Логи <b>%s</b>:\n<pre>%s</pre>", e(contName), html.EscapeString(out))
			b.sendHTML(chatID, text)
			return
		}
		if t.Status == "failed" {
			b.sendHTML(chatID, "❌ Ошибка получения логов: "+e(t.Error))
			return
		}
	}
	b.sendHTML(chatID, "⏱ Таймаут ожидания логов.")
}

func (b *Bot) cbAlertAck(chatID int64, msgID int, incidentID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := b.masterClient.AckBotAlert(ctx, incidentID); err != nil {
		b.replyOrEdit(chatID, msgID, "❌ Ошибка: "+e(err.Error()), nil)
		return
	}
	b.cmdAlerts(chatID, msgID)
}

// ─── Chart generation ────────────────────────────────────────────────────────

func (b *Bot) generateMetricsChart(ctx context.Context, nodeID string) ([]byte, string, error) {
	detail, err := b.masterClient.GetBotNodeDetail(ctx, nodeID)
	if err != nil {
		return nil, "", err
	}
	pts, err := b.masterClient.GetBotNodeMetrics(ctx, nodeID)
	if err != nil {
		return nil, detail.Name, err
	}
	if len(pts) == 0 {
		return nil, detail.Name, fmt.Errorf("нет данных метрик")
	}

	labels := make([]string, len(pts))
	cpuData := make([]float64, len(pts))
	ramData := make([]float64, len(pts))

	for i, p := range pts {
		labels[i] = p.Time
		cpuData[i] = p.CPUPercent
		ramData[i] = p.RAMPercent
	}

	chartConfig := map[string]any{
		"type": "line",
		"data": map[string]any{
			"labels": labels,
			"datasets": []any{
				map[string]any{
					"label":           "CPU %",
					"data":            cpuData,
					"borderColor":     "#4ade80",
					"backgroundColor": "rgba(74,222,128,0.12)",
					"fill":            true,
					"tension":         0.4,
					"pointRadius":     2,
					"borderWidth":     2,
				},
				map[string]any{
					"label":           "RAM %",
					"data":            ramData,
					"borderColor":     "#60a5fa",
					"backgroundColor": "rgba(96,165,250,0.12)",
					"fill":            true,
					"tension":         0.4,
					"pointRadius":     2,
					"borderWidth":     2,
				},
			},
		},
		"options": map[string]any{
			"animation": false,
			"scales": map[string]any{
				"y": map[string]any{
					"min":  0,
					"max":  100,
					"ticks": map[string]any{"color": "#9ca3af", "font": map[string]any{"size": 11}},
					"grid":  map[string]any{"color": "#374151"},
				},
				"x": map[string]any{
					"ticks": map[string]any{
						"color":        "#9ca3af",
						"maxTicksLimit": 8,
						"font":         map[string]any{"size": 10},
					},
					"grid": map[string]any{"color": "#374151"},
				},
			},
			"plugins": map[string]any{
				"legend": map[string]any{
					"labels": map[string]any{"color": "#e5e7eb", "font": map[string]any{"size": 12}},
				},
				"title": map[string]any{
					"display": true,
					"text":    detail.Name + " — последние 2 часа",
					"color":   "#f9fafb",
					"font":    map[string]any{"size": 13},
				},
			},
		},
	}

	reqBody := map[string]any{
		"width":           700,
		"height":          350,
		"backgroundColor": "#111827",
		"devicePixelRatio": 1.5,
		"chart":           chartConfig,
	}

	data, _ := json.Marshal(reqBody)
	req, err := http.NewRequestWithContext(ctx, "POST", "https://quickchart.io/chart", bytes.NewReader(data))
	if err != nil {
		return nil, detail.Name, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.chartClient.Do(req)
	if err != nil {
		return nil, detail.Name, err
	}
	defer resp.Body.Close()

	imgBytes, err := io.ReadAll(resp.Body)
	return imgBytes, detail.Name, err
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func (b *Bot) lookupContainerID(nodeID, namePrefix string) string {
	b.contCacheMu.RLock()
	entry, ok := b.contCache[nodeID]
	b.contCacheMu.RUnlock()
	if !ok || time.Since(entry.fetchedAt) > 10*time.Minute {
		return ""
	}
	for _, c := range entry.items {
		if c.Name == namePrefix || strings.HasPrefix(c.Name, namePrefix) {
			return c.ContainerID
		}
	}
	return ""
}

// replyOrEdit: if msgID != 0 → edit, else → send new.
func (b *Bot) replyOrEdit(chatID int64, msgID int, text string, keyboard *InlineKeyboard) {
	if msgID != 0 {
		if err := b.editHTML(chatID, msgID, text, keyboard); err != nil {
			log.Printf("bot editHTML: %v", err)
			// Fall back to new message
			_ = b.sendText(chatID, text, "HTML", keyboard)
		}
		return
	}
	if err := b.sendText(chatID, text, "HTML", keyboard); err != nil {
		log.Printf("bot sendHTML: %v", err)
	}
}

func (b *Bot) sendHTML(chatID int64, text string) error {
	return b.sendText(chatID, text, "HTML", nil)
}

// ─── Text formatting ─────────────────────────────────────────────────────────

func nodeDetailText(d *client.BotNodeDetail) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s <b>%s</b>\n", nodeIcon(d.Status), e(d.Name))
	if d.PublicIP != "" {
		fmt.Fprintf(&sb, "📍 <code>%s</code>\n", e(d.PublicIP))
	}
	parts := []string{}
	if d.OS != "" {
		parts = append(parts, d.OS)
	}
	if d.Arch != "" {
		parts = append(parts, d.Arch)
	}
	if len(parts) > 0 {
		fmt.Fprintf(&sb, "💻 %s\n", e(strings.Join(parts, " · ")))
	}
	if d.UptimeSeconds != nil && *d.UptimeSeconds > 0 {
		fmt.Fprintf(&sb, "⏱ Uptime: %s\n", formatUptime(*d.UptimeSeconds))
	}
	if d.AgentVersion != "" {
		fmt.Fprintf(&sb, "🔧 Agent <code>v%s</code>\n", e(d.AgentVersion))
	}
	sb.WriteString("\n")

	if d.CPUPercent != nil {
		v := *d.CPUPercent
		fmt.Fprintf(&sb, "CPU  <code>%s %5.1f%%</code>\n", bar(v, 10), v)
	}
	if d.RAMUsedMB != nil && d.RAMTotalMB != nil && *d.RAMTotalMB > 0 {
		pct := float64(*d.RAMUsedMB) / float64(*d.RAMTotalMB) * 100
		fmt.Fprintf(&sb, "RAM  <code>%s %5.1f%%</code>  <i>%.1f/%.1f GB</i>\n",
			bar(pct, 10), pct, float64(*d.RAMUsedMB)/1024, float64(*d.RAMTotalMB)/1024)
	}
	if d.DiskUsedGB != nil && d.DiskTotalGB != nil && *d.DiskTotalGB > 0 {
		pct := *d.DiskUsedGB / *d.DiskTotalGB * 100
		fmt.Fprintf(&sb, "Disk <code>%s %5.1f%%</code>  <i>%.0f/%.0f GB</i>\n",
			bar(pct, 10), pct, *d.DiskUsedGB, *d.DiskTotalGB)
	}
	if d.Load1 != nil {
		fmt.Fprintf(&sb, "Load <code>%.2f</code>\n", *d.Load1)
	}
	return sb.String()
}

func bar(percent float64, width int) string {
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	filled := int(math.Round(percent / 100 * float64(width)))
	return strings.Repeat("▓", filled) + strings.Repeat("░", width-filled)
}

func formatUptime(sec int64) string {
	d := sec / 86400
	h := (sec % 86400) / 3600
	m := (sec % 3600) / 60
	if d > 0 {
		return fmt.Sprintf("%dd %dh %dm", d, h, m)
	}
	if h > 0 {
		return fmt.Sprintf("%dh %dm", h, m)
	}
	return fmt.Sprintf("%dm", m)
}

func nodeIcon(status string) string {
	switch status {
	case "online":
		return "🟢"
	case "offline":
		return "🔴"
	case "pending":
		return "🟡"
	default:
		return "⚪"
	}
}

func containerIcon(state string) string {
	switch state {
	case "running":
		return "🟢"
	case "paused":
		return "🟡"
	case "restarting":
		return "🔄"
	default:
		return "🔴"
	}
}

func severityIcon(sev string) string {
	switch sev {
	case "critical":
		return "🚨"
	case "warning":
		return "⚠️"
	default:
		return "ℹ️"
	}
}

// e is a shorthand for html.EscapeString
func e(s string) string { return html.EscapeString(s) }

// ─── Telegram API wrappers ───────────────────────────────────────────────────

func (b *Bot) getUpdates(offset, timeout int) ([]tgUpdate, error) {
	url := fmt.Sprintf(
		"https://api.telegram.org/bot%s/getUpdates?offset=%d&timeout=%d",
		b.token, offset, timeout,
	)
	resp, err := b.httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result struct {
		OK     bool        `json:"ok"`
		Result []tgUpdate  `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("getUpdates ok=false")
	}
	return result.Result, nil
}

func (b *Bot) sendText(chatID int64, text, parseMode string, keyboard *InlineKeyboard) error {
	type req struct {
		ChatID      int64           `json:"chat_id"`
		Text        string          `json:"text"`
		ParseMode   string          `json:"parse_mode"`
		ReplyMarkup *InlineKeyboard `json:"reply_markup,omitempty"`
	}
	_, err := b.tgPost("/sendMessage", req{
		ChatID: chatID, Text: text, ParseMode: parseMode, ReplyMarkup: keyboard,
	})
	return err
}

func (b *Bot) editHTML(chatID int64, msgID int, text string, keyboard *InlineKeyboard) error {
	type req struct {
		ChatID      int64           `json:"chat_id"`
		MessageID   int             `json:"message_id"`
		Text        string          `json:"text"`
		ParseMode   string          `json:"parse_mode"`
		ReplyMarkup *InlineKeyboard `json:"reply_markup,omitempty"`
	}
	_, err := b.tgPost("/editMessageText", req{
		ChatID: chatID, MessageID: msgID, Text: text, ParseMode: "HTML", ReplyMarkup: keyboard,
	})
	return err
}

func (b *Bot) sendPhoto(chatID int64, imgBytes []byte, caption string, keyboard *InlineKeyboard) error {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("chat_id", fmt.Sprintf("%d", chatID))
	_ = w.WriteField("parse_mode", "HTML")
	if caption != "" {
		_ = w.WriteField("caption", caption)
	}
	if keyboard != nil {
		kb, _ := json.Marshal(keyboard)
		_ = w.WriteField("reply_markup", string(kb))
	}
	part, _ := w.CreateFormFile("photo", "chart.png")
	_, _ = part.Write(imgBytes)
	_ = w.Close()

	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendPhoto", b.token)
	req, err := http.NewRequest("POST", url, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := b.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func (b *Bot) answerCallback(id, text string) error {
	type req struct {
		CallbackQueryID string `json:"callback_query_id"`
		Text            string `json:"text,omitempty"`
	}
	_, err := b.tgPost("/answerCallbackQuery", req{CallbackQueryID: id, Text: text})
	return err
}

func (b *Bot) sendAction(chatID int64, action string) error {
	type req struct {
		ChatID int64  `json:"chat_id"`
		Action string `json:"action"`
	}
	_, err := b.tgPost("/sendChatAction", req{ChatID: chatID, Action: action})
	return err
}

func (b *Bot) tgPost(path string, body any) ([]byte, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	url := "https://api.telegram.org/bot" + b.token + path
	resp, err := b.httpClient.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respData, _ := io.ReadAll(resp.Body)
	return respData, nil
}
