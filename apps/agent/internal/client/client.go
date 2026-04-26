package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

type Client struct {
	masterURL  string
	agentToken string
	http       *http.Client
}

func New(masterURL, agentToken string) *Client {
	return &Client{
		masterURL:  masterURL,
		agentToken: agentToken,
		http:       &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) AgentToken() string {
	return c.agentToken
}

func (c *Client) WebSocketURL(path string) (string, error) {
	parsed, err := url.Parse(c.masterURL)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	case "http":
		parsed.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported master URL scheme: %s", parsed.Scheme)
	}
	parsed.Path = "/api" + path
	parsed.RawQuery = ""
	return parsed.String(), nil
}

func (c *Client) do(ctx context.Context, method, path string, body any) ([]byte, int, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.masterURL+"/api"+path, bodyReader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.agentToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.agentToken)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	return respBody, resp.StatusCode, nil
}

type EnrollRequest struct {
	EnrollToken  string   `json:"enroll_token"`
	Hostname     string   `json:"hostname"`
	PublicIP     string   `json:"public_ip,omitempty"`
	OS           string   `json:"os,omitempty"`
	Arch         string   `json:"arch,omitempty"`
	AgentVersion string   `json:"agent_version"`
	Capabilities []string `json:"capabilities,omitempty"`
}

type EnrollResponse struct {
	NodeID     string `json:"node_id"`
	AgentToken string `json:"agent_token"`
	Config     struct {
		CollectIntervalSeconds  int `json:"collect_interval_seconds"`
		TaskPollIntervalSeconds int `json:"task_poll_interval_seconds"`
	} `json:"config"`
}

func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (*EnrollResponse, error) {
	body, status, err := c.do(ctx, "POST", "/agent/enroll", req)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("enroll failed: %d %s", status, body)
	}
	var resp EnrollResponse
	return &resp, json.Unmarshal(body, &resp)
}

type HeartbeatRequest struct {
	AgentVersion string   `json:"agent_version"`
	Status       string   `json:"status"`
	Capabilities []string `json:"capabilities,omitempty"`
}

type BotConfig struct {
	BotToken       string  `json:"bot_token"`
	AllowedChatIDs []int64 `json:"allowed_chat_ids"`
}

type HeartbeatResponse struct {
	IsBotRunner bool       `json:"is_bot_runner"`
	BotConfig   *BotConfig `json:"bot_config,omitempty"`
}

func (c *Client) Heartbeat(ctx context.Context, version string, capabilities []string) (*HeartbeatResponse, error) {
	body, status, err := c.do(ctx, "POST", "/agent/heartbeat", HeartbeatRequest{
		AgentVersion: version,
		Status:       "online",
		Capabilities: capabilities,
	})
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("heartbeat failed: %d", status)
	}
	var resp HeartbeatResponse
	return &resp, json.Unmarshal(body, &resp)
}

type BotNode struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Status   string `json:"status"`
	Hostname string `json:"hostname"`
	PublicIP string `json:"public_ip"`
}

type BotAlert struct {
	ID           string `json:"id"`
	RuleName     string `json:"rule_name"`
	NodeName     string `json:"node_name"`
	Severity     string `json:"severity"`
	Message      string `json:"message"`
	StartedAt    string `json:"started_at"`
	Acknowledged bool   `json:"acknowledged"`
}

func (c *Client) GetBotNodes(ctx context.Context) ([]BotNode, error) {
	body, status, err := c.do(ctx, "GET", "/agent/bot/nodes", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("get bot nodes failed: %d", status)
	}
	var nodes []BotNode
	return nodes, json.Unmarshal(body, &nodes)
}

func (c *Client) GetBotAlerts(ctx context.Context) ([]BotAlert, error) {
	body, status, err := c.do(ctx, "GET", "/agent/bot/alerts", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("get bot alerts failed: %d", status)
	}
	var alerts []BotAlert
	return alerts, json.Unmarshal(body, &alerts)
}

type BotNodeDetail struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Status        string   `json:"status"`
	Hostname      string   `json:"hostname"`
	PublicIP      string   `json:"public_ip"`
	OS            string   `json:"os"`
	Arch          string   `json:"arch"`
	UptimeSeconds *int64   `json:"uptime_seconds"`
	AgentVersion  string   `json:"agent_version"`
	CPUPercent    *float64 `json:"cpu_percent"`
	RAMUsedMB     *int64   `json:"ram_used_mb"`
	RAMTotalMB    *int64   `json:"ram_total_mb"`
	DiskUsedGB    *float64 `json:"disk_used_gb"`
	DiskTotalGB   *float64 `json:"disk_total_gb"`
	Load1         *float64 `json:"load_1"`
}

type BotMetricPoint struct {
	Time        string  `json:"time"`
	CPUPercent  float64 `json:"cpu_percent"`
	RAMPercent  float64 `json:"ram_percent"`
	DiskPercent float64 `json:"disk_percent"`
}

type BotContainer struct {
	ContainerID string  `json:"container_id"`
	Name        string  `json:"name"`
	Image       string  `json:"image"`
	Status      string  `json:"status"`
	State       string  `json:"state"`
	CPUPercent  float64 `json:"cpu_percent"`
	RAMMB       float64 `json:"ram_mb"`
}

type BotCreateTaskRequest struct {
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type BotTaskStatus struct {
	ID     string         `json:"id"`
	Status string         `json:"status"`
	Result map[string]any `json:"result"`
	Error  string         `json:"error"`
}

func (c *Client) GetBotNodeDetail(ctx context.Context, nodeID string) (*BotNodeDetail, error) {
	body, status, err := c.do(ctx, "GET", "/agent/bot/node/"+nodeID, nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("get bot node detail failed: %d", status)
	}
	var d BotNodeDetail
	return &d, json.Unmarshal(body, &d)
}

func (c *Client) GetBotNodeMetrics(ctx context.Context, nodeID string) ([]BotMetricPoint, error) {
	body, status, err := c.do(ctx, "GET", "/agent/bot/node/"+nodeID+"/metrics", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("get bot node metrics failed: %d", status)
	}
	var pts []BotMetricPoint
	return pts, json.Unmarshal(body, &pts)
}

func (c *Client) GetBotNodeContainers(ctx context.Context, nodeID string) ([]BotContainer, error) {
	body, status, err := c.do(ctx, "GET", "/agent/bot/node/"+nodeID+"/containers", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("get bot node containers failed: %d", status)
	}
	var conts []BotContainer
	return conts, json.Unmarshal(body, &conts)
}

func (c *Client) CreateBotTask(ctx context.Context, nodeID string, req BotCreateTaskRequest) (*BotTaskStatus, error) {
	body, status, err := c.do(ctx, "POST", "/agent/bot/node/"+nodeID+"/task", req)
	if err != nil {
		return nil, err
	}
	if status != 201 {
		return nil, fmt.Errorf("create bot task failed: %d %s", status, body)
	}
	var t BotTaskStatus
	return &t, json.Unmarshal(body, &t)
}

func (c *Client) AckBotAlert(ctx context.Context, incidentID string) error {
	_, status, err := c.do(ctx, "POST", "/agent/bot/alert/"+incidentID+"/ack", map[string]any{})
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("ack bot alert failed: %d", status)
	}
	return nil
}

func (c *Client) GetBotTask(ctx context.Context, taskID string) (*BotTaskStatus, error) {
	body, status, err := c.do(ctx, "GET", "/agent/bot/tasks/"+taskID, nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("get bot task failed: %d", status)
	}
	var t BotTaskStatus
	return &t, json.Unmarshal(body, &t)
}

type SnapshotMetrics struct {
	CPUPercent     float64 `json:"cpu_percent"`
	RAMUsedMB      int64   `json:"ram_used_mb"`
	RAMTotalMB     int64   `json:"ram_total_mb"`
	DiskUsedGB     float64 `json:"disk_used_gb"`
	DiskTotalGB    float64 `json:"disk_total_gb"`
	Load1          float64 `json:"load_1"`
	Load5          float64 `json:"load_5"`
	Load15         float64 `json:"load_15"`
	NetworkRXBytes int64   `json:"network_rx_bytes"`
	NetworkTXBytes int64   `json:"network_tx_bytes"`
}

type SnapshotSystem struct {
	Hostname      string   `json:"hostname,omitempty"`
	PublicIP      string   `json:"public_ip,omitempty"`
	OS            string   `json:"os,omitempty"`
	Arch          string   `json:"arch,omitempty"`
	UptimeSeconds int64    `json:"uptime_seconds,omitempty"`
	Kernel        string   `json:"kernel,omitempty"`
	CPUModel      string   `json:"cpu_model,omitempty"`
	CPUCores      int      `json:"cpu_cores,omitempty"`
	LocalIPs      []string `json:"local_ips"`
}

type SnapshotContainer struct {
	ContainerID  string            `json:"container_id"`
	Name         string            `json:"name"`
	Image        string            `json:"image"`
	Status       string            `json:"status"`
	State        string            `json:"state"`
	Ports        []string          `json:"ports"`
	Networks     []string          `json:"networks"`
	Mounts       []string          `json:"mounts"`
	Labels       map[string]string `json:"labels"`
	CPUPercent   float64           `json:"cpu_percent"`
	RAMMB        float64           `json:"ram_mb"`
	RestartCount int               `json:"restart_count"`
	HealthStatus string            `json:"health_status"`
}

type SnapshotPort struct {
	Protocol      string `json:"protocol"`
	Port          int    `json:"port"`
	ListenIP      string `json:"listen_ip,omitempty"`
	ProcessName   string `json:"process_name,omitempty"`
	PID           int    `json:"pid,omitempty"`
	UserName      string `json:"user_name,omitempty"`
	ContainerName string `json:"container_name,omitempty"`
}

type SnapshotRequest struct {
	System              *SnapshotSystem     `json:"system,omitempty"`
	Metrics             *SnapshotMetrics    `json:"metrics,omitempty"`
	Containers          []SnapshotContainer `json:"containers"`
	Ports               []SnapshotPort      `json:"ports"`
	ContainersCollected bool                `json:"containers_collected"`
	PortsCollected      bool                `json:"ports_collected"`
	Errors              []string            `json:"errors"`
	Capabilities        []string            `json:"capabilities,omitempty"`
}

func (c *Client) Snapshot(ctx context.Context, snap SnapshotRequest) error {
	_, status, err := c.do(ctx, "POST", "/agent/snapshot", snap)
	if err != nil {
		return err
	}
	if status != 204 {
		return fmt.Errorf("snapshot failed: %d", status)
	}
	return nil
}

type Task struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

func (c *Client) GetTasks(ctx context.Context) ([]Task, error) {
	body, status, err := c.do(ctx, "GET", "/agent/tasks", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("get tasks failed: %d", status)
	}
	var tasks []Task
	return tasks, json.Unmarshal(body, &tasks)
}

type TaskResultRequest struct {
	Status string         `json:"status"`
	Result map[string]any `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
}

func (c *Client) SubmitTaskResult(ctx context.Context, taskID string, result TaskResultRequest) error {
	_, status, err := c.do(ctx, "POST", "/agent/tasks/"+taskID+"/result", result)
	if err != nil {
		return err
	}
	if status != 204 {
		return fmt.Errorf("submit result failed: %d", status)
	}
	return nil
}
