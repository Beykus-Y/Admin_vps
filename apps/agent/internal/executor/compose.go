package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func dockerComposeAction(ctx context.Context, payload map[string]any, action string) (map[string]any, error) {
	baseArgs, services, err := composeArgs(payload)
	if err != nil {
		return nil, err
	}

	var args []string
	switch action {
	case "pull":
		args = append(baseArgs, "pull")
		args = append(args, services...)
	case "up":
		args = append(baseArgs, "up", "-d")
		args = append(args, services...)
	case "down":
		args = append(baseArgs, "down")
	default:
		return nil, fmt.Errorf("unsupported compose action: %s", action)
	}

	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker %s: %w\n%s", strings.Join(args, " "), err, out)
	}
	return map[string]any{
		"message": fmt.Sprintf("docker compose %s ok", action),
		"output":  string(out),
	}, nil
}

func composeArgs(payload map[string]any) ([]string, []string, error) {
	installDir := stringPayload(payload, "install_dir", "")
	composeFile := stringPayload(payload, "compose_file", "")
	if composeFile == "" && installDir != "" {
		composeFile = filepath.Join(installDir, "docker-compose.yml")
	}
	if composeFile == "" {
		return nil, nil, fmt.Errorf("missing compose_file or install_dir")
	}
	if !filepath.IsAbs(composeFile) {
		return nil, nil, fmt.Errorf("compose_file must be an absolute path")
	}
	if _, err := os.Stat(composeFile); err != nil {
		return nil, nil, fmt.Errorf("compose file unavailable: %w", err)
	}

	baseArgs := []string{"compose", "-f", composeFile}
	overrideFile := stringPayload(payload, "override_file", "")
	if overrideFile == "" && installDir != "" {
		overrideFile = filepath.Join(installDir, "docker-compose.override.yml")
	}
	if overrideFile != "" {
		if _, err := os.Stat(overrideFile); err == nil {
			baseArgs = append(baseArgs, "-f", overrideFile)
		}
	}

	envFile := stringPayload(payload, "env_file", "")
	if envFile == "" && installDir != "" {
		envFile = filepath.Join(installDir, ".env")
	}
	if envFile != "" {
		if _, err := os.Stat(envFile); err == nil {
			baseArgs = append(baseArgs, "--env-file", envFile)
		}
	}

	return baseArgs, stringSlicePayload(payload, "services"), nil
}

func stringSlicePayload(payload map[string]any, key string) []string {
	raw, ok := payload[key]
	if !ok {
		return nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && text != "" {
			out = append(out, text)
		}
	}
	return out
}
