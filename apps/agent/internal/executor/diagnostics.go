package executor

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const diagnosticsMaxOutput = 220_000

func diagnosticsProcesses(ctx context.Context, payload map[string]any) (map[string]any, error) {
	limit := intPayload(payload, "limit", 25, 5, 80)
	out, err := runDiagnosticCommand(ctx, 8*time.Second, "ps", "-eo", "pid,ppid,user,comm,%cpu,%mem,rss,args", "--sort=-%cpu")
	if err != nil {
		return nil, err
	}
	lines := limitLines(out, limit+1)
	return map[string]any{"limit": limit, "output": strings.Join(lines, "\n")}, nil
}

func diagnosticsDiskUsage(ctx context.Context, payload map[string]any) (map[string]any, error) {
	path := safeDiagnosticPath(stringPayload(payload, "path", "/"))
	limit := intPayload(payload, "limit", 25, 5, 80)
	dfOut, dfErr := runDiagnosticCommand(ctx, 8*time.Second, "df", "-B1", "-T", path)
	duOut, duErr := runDiagnosticCommand(ctx, 30*time.Second, "du", "-x", "-B1", "--max-depth=1", path)

	result := map[string]any{"path": path, "limit": limit}
	if dfErr != nil {
		result["df_error"] = dfErr.Error()
	} else {
		result["df"] = dfOut
	}
	if duErr != nil {
		result["du_error"] = duErr.Error()
	} else {
		result["top_entries"] = topSizeLines(duOut, limit)
	}
	return result, nil
}

func diagnosticsFindFiles(ctx context.Context, payload map[string]any) (map[string]any, error) {
	path := safeDiagnosticPath(stringPayload(payload, "path", "/"))
	pattern := stringPayload(payload, "pattern", "*")
	if strings.Contains(pattern, "/") || strings.Contains(pattern, "\x00") || len(pattern) > 80 {
		return nil, fmt.Errorf("invalid pattern")
	}
	minSizeMB := intPayload(payload, "min_size_mb", 100, 0, 1024*1024)
	limit := intPayload(payload, "limit", 50, 5, 100)

	args := []string{path, "-xdev", "-type", "f"}
	if pattern != "" && pattern != "*" {
		args = append(args, "-iname", pattern)
	}
	if minSizeMB > 0 {
		args = append(args, "-size", fmt.Sprintf("+%dM", minSizeMB))
	}
	args = append(args, "-printf", "%s\t%p\n")
	out, err := runDiagnosticCommand(ctx, 35*time.Second, "find", args...)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "pattern": pattern, "min_size_mb": minSizeMB, "files": topSizeLines(out, limit)}, nil
}

func runDiagnosticCommand(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(cmdCtx, name, args...).CombinedOutput()
	if cmdCtx.Err() == context.DeadlineExceeded {
		return truncateDiagnosticOutput(string(out)), fmt.Errorf("diagnostic command timed out")
	}
	if err != nil {
		return truncateDiagnosticOutput(string(out)), fmt.Errorf("%s failed: %w\n%s", name, err, truncateDiagnosticOutput(string(out)))
	}
	return truncateDiagnosticOutput(string(out)), nil
}

func safeDiagnosticPath(raw string) string {
	if raw == "" || strings.Contains(raw, "\x00") {
		return "/"
	}
	cleaned := filepath.Clean(raw)
	if !strings.HasPrefix(cleaned, "/") {
		return "/"
	}
	allowed := []string{"/", "/home", "/opt", "/srv", "/var", "/tmp", "/root"}
	for _, prefix := range allowed {
		if cleaned == prefix || strings.HasPrefix(cleaned, prefix+"/") {
			return cleaned
		}
	}
	return "/"
}

func stringPayload(payload map[string]any, key string, fallback string) string {
	if value, ok := payload[key].(string); ok {
		return value
	}
	return fallback
}

func intPayload(payload map[string]any, key string, fallback int, minValue int, maxValue int) int {
	value := fallback
	switch raw := payload[key].(type) {
	case float64:
		value = int(raw)
	case int:
		value = raw
	case string:
		if parsed, err := strconv.Atoi(raw); err == nil {
			value = parsed
		}
	}
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func truncateDiagnosticOutput(value string) string {
	if len(value) <= diagnosticsMaxOutput {
		return value
	}
	return value[:diagnosticsMaxOutput] + "\n...[truncated]"
}

func limitLines(value string, limit int) []string {
	lines := strings.Split(strings.TrimSpace(value), "\n")
	if len(lines) > limit {
		return lines[:limit]
	}
	return lines
}

func topSizeLines(value string, limit int) []map[string]any {
	items := []map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(value), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		size, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
		if err != nil {
			continue
		}
		items = append(items, map[string]any{"bytes": size, "path": parts[1]})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i]["bytes"].(int64) > items[j]["bytes"].(int64)
	})
	if len(items) > limit {
		return items[:limit]
	}
	return items
}
