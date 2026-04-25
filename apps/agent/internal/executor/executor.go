package executor

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	agentclient "github.com/filincontrol/agent/internal/client"
)

func Execute(ctx context.Context, task agentclient.Task) (map[string]any, error) {
	switch task.Type {
	case "container.restart":
		return containerAction(ctx, task.Payload, "restart")
	case "container.stop":
		return containerAction(ctx, task.Payload, "stop")
	case "container.start":
		return containerAction(ctx, task.Payload, "start")
	case "service.restart":
		return serviceRestart(ctx, task.Payload)
	case "agent.update":
		return selfUpdate(ctx, task.Payload)
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
