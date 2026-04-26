package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/filincontrol/agent/internal/bot"
	"github.com/filincontrol/agent/internal/client"
	"github.com/filincontrol/agent/internal/collector"
	"github.com/filincontrol/agent/internal/config"
	"github.com/filincontrol/agent/internal/executor"
	"github.com/filincontrol/agent/internal/terminal"
)

var version = "dev"

var publicIPCache = struct {
	sync.Mutex
	value     string
	fetchedAt time.Time
}{}

var botState = struct {
	sync.Mutex
	instance *bot.Bot
}{}

func main() {
	configPath := flag.String("config", "/etc/filin-agent/config.yml", "path to config file")
	enrollToken := flag.String("enroll-token", "", "one-time enroll token")
	masterURL := flag.String("master-url", "", "master URL (required for enroll)")
	flag.Parse()

	if *enrollToken != "" {
		runEnroll(*masterURL, *enrollToken, *configPath)
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	c := client.New(cfg.MasterURL, cfg.AgentToken)
	log.Printf("filin-agent %s started, node=%s master=%s", version, cfg.NodeID, cfg.MasterURL)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		sendSnapshot(ctx, c)
	}()

	collectTick := time.NewTicker(time.Duration(cfg.CollectIntervalSeconds) * time.Second)
	taskTick := time.NewTicker(time.Duration(cfg.TaskPollIntervalSeconds) * time.Second)
	heartbeatTick := time.NewTicker(8 * time.Second)
	taskProcessing := make(chan struct{}, 1)
	capabilities := executor.Capabilities()

	for {
		select {
		case <-heartbeatTick.C:
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			resp, err := c.Heartbeat(ctx, version, capabilities)
			cancel()
			if err != nil {
				log.Printf("heartbeat error: %v", err)
			} else {
				updateBotRunner(resp, c)
			}

		case <-collectTick.C:
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				sendSnapshot(ctx, c)
			}()

		case <-taskTick.C:
			select {
			case taskProcessing <- struct{}{}:
			default:
				continue
			}
			go func() {
				defer func() { <-taskProcessing }()
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
				defer cancel()
				processTasks(ctx, c)
			}()
		}
	}
}

func updateBotRunner(resp *client.HeartbeatResponse, c *client.Client) {
	botState.Lock()
	defer botState.Unlock()

	if resp.IsBotRunner && resp.BotConfig != nil && resp.BotConfig.BotToken != "" {
		if botState.instance == nil {
			botState.instance = bot.New(resp.BotConfig.BotToken, resp.BotConfig.AllowedChatIDs, c)
			botState.instance.Start()
		}
	} else {
		if botState.instance != nil {
			botState.instance.Stop()
			botState.instance = nil
		}
	}
}

func sendSnapshot(ctx context.Context, c *client.Client) {
	inventoryErrors := []string{}
	system, err := collector.CollectSystem(ctx)
	if err != nil {
		msg := fmt.Sprintf("System inventory unavailable: %v", err)
		log.Print(msg)
		inventoryErrors = append(inventoryErrors, msg)
	}
	if publicIP := detectPublicIP(ctx); publicIP != "" {
		if system == nil {
			system = &client.SnapshotSystem{LocalIPs: []string{}}
		}
		system.PublicIP = publicIP
	}

	metrics, err := collector.CollectMetrics(ctx)
	if err != nil {
		log.Printf("collect metrics: %v", err)
	}

	containersCollected := true
	containers, err := collector.CollectContainers(ctx)
	if err != nil {
		containers = []client.SnapshotContainer{}
		containersCollected = false
		msg := fmt.Sprintf("Docker inventory unavailable: %v", err)
		log.Print(msg)
		inventoryErrors = append(inventoryErrors, msg)
	}

	portsCollected := true
	ports, err := collector.CollectPorts()
	if err != nil {
		ports = []client.SnapshotPort{}
		portsCollected = false
		msg := fmt.Sprintf("Port inventory unavailable: %v", err)
		log.Print(msg)
		inventoryErrors = append(inventoryErrors, msg)
	}
	attachContainerNamesToPorts(ports, containers)

	snap := client.SnapshotRequest{
		System:              system,
		Metrics:             metrics,
		Containers:          containers,
		Ports:               ports,
		ContainersCollected: containersCollected,
		PortsCollected:      portsCollected,
		Errors:              inventoryErrors,
		Capabilities:        executor.Capabilities(),
	}
	if err := c.Snapshot(ctx, snap); err != nil {
		log.Printf("snapshot error: %v", err)
	}
}

func attachContainerNamesToPorts(ports []client.SnapshotPort, containers []client.SnapshotContainer) {
	published := map[string]string{}
	for _, container := range containers {
		for _, portMapping := range container.Ports {
			proto, port, ok := parsePublishedPort(portMapping)
			if ok {
				published[fmt.Sprintf("%s/%d", proto, port)] = container.Name
			}
		}
	}
	for i := range ports {
		key := fmt.Sprintf("%s/%d", ports[i].Protocol, ports[i].Port)
		if name := published[key]; name != "" {
			ports[i].ContainerName = name
		}
	}
}

func parsePublishedPort(value string) (proto string, port int, ok bool) {
	parts := strings.Split(value, "/")
	if len(parts) != 2 {
		return "", 0, false
	}
	addressParts := strings.Split(parts[0], ":")
	if len(addressParts) < 2 {
		return "", 0, false
	}
	publishedPort := addressParts[len(addressParts)-2]
	parsed, err := strconv.Atoi(publishedPort)
	if err != nil {
		return "", 0, false
	}
	return parts[1], parsed, true
}

func processTasks(ctx context.Context, c *client.Client) {
	tasks, err := c.GetTasks(ctx)
	if err != nil {
		log.Printf("get tasks: %v", err)
		return
	}
	for _, task := range tasks {
		log.Printf("executing task %s type=%s", task.ID, task.Type)
		if task.Type == "terminal.open" {
			sessionID, _ := task.Payload["session_id"].(string)
			shell, _ := task.Payload["shell"].(string)
			if sessionID == "" {
				if err := c.SubmitTaskResult(ctx, task.ID, client.TaskResultRequest{Status: "failed", Error: "missing terminal session_id"}); err != nil {
					log.Printf("submit task result: %v", err)
				}
				continue
			}
			go func() {
				if err := terminal.StartSession(context.Background(), c, sessionID, shell); err != nil {
					log.Printf("terminal session %s: %v", sessionID, err)
				}
			}()
			if err := c.SubmitTaskResult(ctx, task.ID, client.TaskResultRequest{
				Status: "success",
				Result: map[string]any{"message": "terminal session connecting", "session_id": sessionID},
			}); err != nil {
				log.Printf("submit task result: %v", err)
			}
			continue
		}
		result, execErr := executor.Execute(ctx, task)
		var req client.TaskResultRequest
		if execErr != nil {
			req = client.TaskResultRequest{Status: "failed", Error: execErr.Error()}
		} else {
			req = client.TaskResultRequest{Status: "success", Result: result}
		}
		if err := c.SubmitTaskResult(ctx, task.ID, req); err != nil {
			log.Printf("submit task result: %v", err)
		}
	}
}

func runEnroll(masterURL, enrollToken, configPath string) {
	if masterURL == "" {
		log.Fatal("--master-url is required for enrollment")
	}

	hostname, _ := os.Hostname()
	c := client.New(masterURL, "")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := c.Enroll(ctx, client.EnrollRequest{
		EnrollToken:  enrollToken,
		Hostname:     hostname,
		PublicIP:     detectPublicIP(ctx),
		OS:           detectOS(),
		Arch:         runtime.GOARCH,
		AgentVersion: version,
		Capabilities: executor.Capabilities(),
	})
	if err != nil {
		log.Fatalf("enroll failed: %v", err)
	}

	cfg := &config.Config{
		NodeID:                  resp.NodeID,
		MasterURL:               masterURL,
		AgentToken:              resp.AgentToken,
		CollectIntervalSeconds:  resp.Config.CollectIntervalSeconds,
		TaskPollIntervalSeconds: resp.Config.TaskPollIntervalSeconds,
	}
	if cfg.CollectIntervalSeconds == 0 {
		cfg.CollectIntervalSeconds = 10
	}
	if cfg.TaskPollIntervalSeconds == 0 {
		cfg.TaskPollIntervalSeconds = 5
	}

	if err := os.MkdirAll("/etc/filin-agent", 0755); err != nil {
		log.Fatalf("create config dir: %v", err)
	}
	if err := config.Save(configPath, cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}

	fmt.Printf("Enrolled successfully! Node ID: %s\nConfig saved to %s\n", resp.NodeID, configPath)
}

func detectPublicIP(ctx context.Context) string {
	publicIPCache.Lock()
	if publicIPCache.value != "" && time.Since(publicIPCache.fetchedAt) < 10*time.Minute {
		value := publicIPCache.value
		publicIPCache.Unlock()
		return value
	}
	publicIPCache.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.ipify.org", nil)
	if err != nil {
		return ""
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return ""
	}
	value := strings.TrimSpace(string(body))
	if value != "" {
		publicIPCache.Lock()
		publicIPCache.value = value
		publicIPCache.fetchedAt = time.Now()
		publicIPCache.Unlock()
	}
	return value
}

func detectOS() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return runtime.GOOS
	}
	for _, line := range splitLines(string(data)) {
		if len(line) > 12 && line[:12] == "PRETTY_NAME=" {
			return trimQuotes(line[12:])
		}
	}
	return runtime.GOOS
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i, c := range s {
		if c == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func trimQuotes(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1]
	}
	return s
}
