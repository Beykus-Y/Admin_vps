package bot

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/filincontrol/agent/internal/client"
)

type Bot struct {
	token          string
	allowedChatIDs map[int64]struct{}
	masterClient   *client.Client
	stopCh         chan struct{}
	mu             sync.Mutex
	running        bool
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

type tgUpdate struct {
	UpdateID int `json:"update_id"`
	Message  *struct {
		Chat struct {
			ID int64 `json:"id"`
		} `json:"chat"`
		Text string `json:"text"`
	} `json:"message"`
}

func (b *Bot) run() {
	offset := 0
	httpClient := &http.Client{Timeout: 40 * time.Second}

	for {
		select {
		case <-b.stopCh:
			return
		default:
		}

		updates, err := b.getUpdates(httpClient, offset, 30)
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
			if upd.Message == nil {
				continue
			}
			chatID := upd.Message.Chat.ID
			if len(b.allowedChatIDs) > 0 {
				if _, ok := b.allowedChatIDs[chatID]; !ok {
					continue
				}
			}
			go b.handleMessage(chatID, strings.TrimSpace(upd.Message.Text))
		}
	}
}

func (b *Bot) getUpdates(httpClient *http.Client, offset, timeout int) ([]tgUpdate, error) {
	apiURL := fmt.Sprintf(
		"https://api.telegram.org/bot%s/getUpdates?offset=%d&timeout=%d",
		b.token, offset, timeout,
	)
	resp, err := httpClient.Get(apiURL)
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
		return nil, fmt.Errorf("getUpdates returned ok=false")
	}
	return result.Result, nil
}

func (b *Bot) handleMessage(chatID int64, text string) {
	parts := strings.Fields(text)
	if len(parts) == 0 {
		return
	}
	cmd := strings.ToLower(parts[0])
	if idx := strings.Index(cmd, "@"); idx != -1 {
		cmd = cmd[:idx]
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var reply string
	switch cmd {
	case "/start", "/help":
		reply = b.cmdHelp()
	case "/status", "/nodes":
		reply = b.cmdNodes(ctx)
	case "/alerts":
		reply = b.cmdAlerts(ctx)
	default:
		reply = "Неизвестная команда.\n\n/status — статус нод\n/alerts — активные алерты\n/help — справка"
	}

	if err := b.sendMessage(chatID, reply); err != nil {
		log.Printf("telegram sendMessage to %d: %v", chatID, err)
	}
}

func (b *Bot) cmdHelp() string {
	return "FilinControl Bot\n\n" +
		"/status — статус всех нод\n" +
		"/alerts — активные алерты\n" +
		"/help — эта справка"
}

func (b *Bot) cmdNodes(ctx context.Context) string {
	nodes, err := b.masterClient.GetBotNodes(ctx)
	if err != nil {
		return fmt.Sprintf("Ошибка: %v", err)
	}
	if len(nodes) == 0 {
		return "Нод не найдено."
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Ноды (%d):\n\n", len(nodes)))
	for _, n := range nodes {
		icon := "🟢"
		switch n.Status {
		case "offline":
			icon = "🔴"
		case "pending":
			icon = "🟡"
		}
		sb.WriteString(fmt.Sprintf("%s %s — %s\n", icon, n.Name, n.Status))
		if n.Hostname != "" {
			sb.WriteString(fmt.Sprintf("   %s\n", n.Hostname))
		}
		if n.PublicIP != "" {
			sb.WriteString(fmt.Sprintf("   %s\n", n.PublicIP))
		}
	}
	return sb.String()
}

func (b *Bot) cmdAlerts(ctx context.Context) string {
	alerts, err := b.masterClient.GetBotAlerts(ctx)
	if err != nil {
		return fmt.Sprintf("Ошибка: %v", err)
	}
	if len(alerts) == 0 {
		return "Активных алертов нет."
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Активных алертов: %d\n\n", len(alerts)))
	for _, a := range alerts {
		icon := "⚠️"
		switch a.Severity {
		case "critical":
			icon = "🚨"
		case "info":
			icon = "ℹ️"
		}
		nodePart := ""
		if a.NodeName != "" {
			nodePart = fmt.Sprintf("[%s] ", a.NodeName)
		}
		sb.WriteString(fmt.Sprintf("%s %s%s\n", icon, nodePart, a.Message))
	}
	return sb.String()
}

func (b *Bot) sendMessage(chatID int64, text string) error {
	apiURL := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", b.token)
	params := url.Values{}
	params.Set("chat_id", fmt.Sprintf("%d", chatID))
	params.Set("text", text)

	resp, err := http.PostForm(apiURL, params)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}
