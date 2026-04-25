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

func (c *Client) Heartbeat(ctx context.Context, version string, capabilities []string) error {
	_, status, err := c.do(ctx, "POST", "/agent/heartbeat", HeartbeatRequest{
		AgentVersion: version,
		Status:       "online",
		Capabilities: capabilities,
	})
	if err != nil {
		return err
	}
	if status != 204 {
		return fmt.Errorf("heartbeat failed: %d", status)
	}
	return nil
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
