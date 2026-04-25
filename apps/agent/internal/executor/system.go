package executor

import (
	"context"
	"fmt"
	"os/exec"
)

func systemReboot(ctx context.Context, payload map[string]any) (map[string]any, error) {
	delay := "1"
	if seconds, ok := payload["delay_minutes"].(float64); ok && seconds > 0 {
		delay = fmt.Sprintf("%.0f", seconds)
	}
	out, err := exec.CommandContext(ctx, "shutdown", "-r", "+"+delay, "FilinControl requested reboot").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("schedule reboot: %w\n%s", err, out)
	}
	return map[string]any{"message": fmt.Sprintf("reboot scheduled in %s minute(s)", delay)}, nil
}
