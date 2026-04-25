package executor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// selfUpdate downloads a new agent binary, verifies checksum, replaces the binary, restarts via systemd.
func selfUpdate(ctx context.Context, payload map[string]any) (map[string]any, error) {
	downloadURL, _ := payload["download_url"].(string)
	expectedChecksum, _ := payload["checksum_sha256"].(string)

	if downloadURL == "" {
		return nil, fmt.Errorf("missing download_url in payload")
	}

	// Detect current binary path
	selfPath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve self path: %w", err)
	}

	// Validate URL is a GitHub release URL (basic safety check)
	if !strings.HasPrefix(downloadURL, "https://github.com/") &&
		!strings.HasPrefix(downloadURL, "https://objects.githubusercontent.com/") {
		return nil, fmt.Errorf("download_url must be a github.com URL")
	}

	// Download to temp file
	tmpFile, err := os.CreateTemp("", "filin-agent-update-*")
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer func() {
		tmpFile.Close()
		os.Remove(tmpPath) // cleanup if we error before replacing
	}()

	httpClient := &http.Client{Timeout: 120 * time.Second}
	req, err := http.NewRequestWithContext(ctx, "GET", downloadURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("download HTTP %d", resp.StatusCode)
	}

	hasher := sha256.New()
	writer := io.MultiWriter(tmpFile, hasher)
	if _, err := io.Copy(writer, resp.Body); err != nil {
		return nil, fmt.Errorf("write download: %w", err)
	}
	tmpFile.Close()

	// Verify checksum if provided
	if expectedChecksum != "" {
		actual := fmt.Sprintf("%x", hasher.Sum(nil))
		if actual != strings.ToLower(strings.TrimSpace(expectedChecksum)) {
			return nil, fmt.Errorf("checksum mismatch: expected %s got %s", expectedChecksum, actual)
		}
	}

	// Make executable
	if err := os.Chmod(tmpPath, 0755); err != nil {
		return nil, fmt.Errorf("chmod: %w", err)
	}

	// Sanity check: can the binary run? (basic test)
	testOut, testErr := exec.CommandContext(ctx, tmpPath, "--help").CombinedOutput()
	_ = testOut
	// --help exits non-zero (flag.Parse exits on unknown flags), so only fail on panic/signal
	if testErr != nil && strings.Contains(testErr.Error(), "signal") {
		return nil, fmt.Errorf("new binary failed sanity check: %v", testErr)
	}

	// Replace binary: rename temp over current (atomic on same filesystem)
	backupPath := selfPath + ".bak"
	_ = os.Rename(selfPath, backupPath) // backup old binary

	if err := os.Rename(tmpPath, selfPath); err != nil {
		// restore backup
		_ = os.Rename(backupPath, selfPath)
		return nil, fmt.Errorf("replace binary: %w", err)
	}
	os.Remove(backupPath)

	// Restart via systemd (non-blocking — agent will be killed and restarted)
	go func() {
		time.Sleep(500 * time.Millisecond)
		_ = exec.Command("systemctl", "restart", "filin-agent").Run()
	}()

	return map[string]any{
		"message": "agent updated successfully, restarting",
		"arch":    runtime.GOARCH,
	}, nil
}
