package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	agentclient "github.com/filincontrol/agent/internal/client"
)

var supportedTaskTypes = []string{
	"container.restart",
	"container.stop",
	"container.start",
	"container.logs",
	"service.restart",
	"docker.compose.pull",
	"docker.compose.up",
	"docker.compose.down",
	"system.reboot",
	"agent.update",
	"master.update",
	"diagnostics.processes",
	"diagnostics.disk_usage",
	"diagnostics.find_files",
	"terminal.session",
}

func Capabilities() []string {
	items := make([]string, len(supportedTaskTypes))
	copy(items, supportedTaskTypes)
	return items
}

func Execute(ctx context.Context, task agentclient.Task) (map[string]any, error) {
	switch task.Type {
	case "container.restart":
		return containerAction(ctx, task.Payload, "restart")
	case "container.stop":
		return containerAction(ctx, task.Payload, "stop")
	case "container.start":
		return containerAction(ctx, task.Payload, "start")
	case "container.logs":
		return containerLogs(ctx, task.Payload)
	case "service.restart":
		return serviceRestart(ctx, task.Payload)
	case "docker.compose.pull":
		return dockerComposeAction(ctx, task.Payload, "pull")
	case "docker.compose.up":
		return dockerComposeAction(ctx, task.Payload, "up")
	case "docker.compose.down":
		return dockerComposeAction(ctx, task.Payload, "down")
	case "system.reboot":
		return systemReboot(ctx, task.Payload)
	case "agent.update":
		return selfUpdate(ctx, task.Payload)
	case "master.update":
		return masterUpdate(ctx, task.Payload)
	case "diagnostics.processes":
		return diagnosticsProcesses(ctx, task.Payload)
	case "diagnostics.disk_usage":
		return diagnosticsDiskUsage(ctx, task.Payload)
	case "diagnostics.find_files":
		return diagnosticsFindFiles(ctx, task.Payload)
	default:
		return nil, fmt.Errorf("unknown task type: %s", task.Type)
	}
}

func containerAction(ctx context.Context, payload map[string]any, action string) (map[string]any, error) {
	id, _ := payload["container_id"].(string)
	if id == "" {
		return nil, fmt.Errorf("missing container_id")
	}

	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	defer cli.Close()

	switch action {
	case "restart":
		err = cli.ContainerRestart(ctx, id, container.StopOptions{})
	case "stop":
		err = cli.ContainerStop(ctx, id, container.StopOptions{})
	case "start":
		err = cli.ContainerStart(ctx, id, container.StartOptions{})
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"message": fmt.Sprintf("container %s: %s ok", id, action)}, nil
}

func containerLogs(ctx context.Context, payload map[string]any) (map[string]any, error) {
	id, _ := payload["container_id"].(string)
	if id == "" {
		return nil, fmt.Errorf("missing container_id")
	}

	tail := "200"
	if value, ok := payload["tail"].(float64); ok && value > 0 {
		tail = fmt.Sprintf("%.0f", value)
	}

	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	defer cli.Close()

	reader, err := cli.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Timestamps: false,
		Tail:       tail,
	})
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, &stderr, reader); err != nil && err != io.EOF {
		return nil, err
	}

	return map[string]any{
		"stdout": stdout.String(),
		"stderr": stderr.String(),
	}, nil
}

func serviceRestart(ctx context.Context, payload map[string]any) (map[string]any, error) {
	svc, _ := payload["service"].(string)
	if svc == "" {
		return nil, fmt.Errorf("missing service name")
	}
	out, err := exec.CommandContext(ctx, "systemctl", "restart", svc).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("systemctl restart %s: %w\n%s", svc, err, out)
	}
	return map[string]any{"message": fmt.Sprintf("service %s restarted", svc)}, nil
}
