package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func masterUpdate(ctx context.Context, payload map[string]any) (map[string]any, error) {
	installDir := stringPayload(payload, "install_dir", "/opt/filincontrol")
	composeFile := stringPayload(payload, "compose_file", filepath.Join(installDir, "docker-compose.yml"))
	overrideFile := stringPayload(payload, "override_file", filepath.Join(installDir, "docker-compose.override.yml"))
	envFile := stringPayload(payload, "env_file", filepath.Join(installDir, ".env"))

	if !strings.HasPrefix(filepath.Clean(installDir), "/opt/filincontrol") {
		return nil, fmt.Errorf("install_dir must be under /opt/filincontrol")
	}
	if _, err := os.Stat(composeFile); err != nil {
		return nil, fmt.Errorf("compose file unavailable: %w", err)
	}

	baseArgs := []string{"compose", "-f", composeFile}
	if _, err := os.Stat(overrideFile); err == nil {
		baseArgs = append(baseArgs, "-f", overrideFile)
	}
	if _, err := os.Stat(envFile); err == nil {
		baseArgs = append(baseArgs, "--env-file", envFile)
	}

	steps := [][]string{
		append(append([]string{}, baseArgs...), "pull"),
		append(append([]string{}, baseArgs...), "run", "--rm", "-T", "migrate"),
		append(append([]string{}, baseArgs...), "up", "-d", "--remove-orphans"),
	}
	for _, args := range steps {
		if out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("docker %s: %w\n%s", strings.Join(args, " "), err, out)
		}
	}
	_ = exec.CommandContext(ctx, "docker", "image", "prune", "-f").Run()

	return map[string]any{"message": "master update completed"}, nil
}

func stringPayload(payload map[string]any, key, fallback string) string {
	value, _ := payload[key].(string)
	if value == "" {
		return fallback
	}
	return value
}
