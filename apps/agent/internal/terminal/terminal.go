package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/filincontrol/agent/internal/client"
)

type wsMessage struct {
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Message string `json:"message,omitempty"`
	Code    int    `json:"code,omitempty"`
	Cols    int    `json:"cols,omitempty"`
	Rows    int    `json:"rows,omitempty"`
}

func StartSession(ctx context.Context, c *client.Client, sessionID string, shell string) error {
	if sessionID == "" {
		return fmt.Errorf("missing terminal session_id")
	}
	wsURL, err := c.WebSocketURL("/agent/terminal/" + sessionID)
	if err != nil {
		return err
	}
	conn, err := dialWebSocket(ctx, wsURL, c.AgentToken())
	if err != nil {
		return err
	}
	defer conn.close()

	cmd := exec.Command(allowedShell(shell))
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")

	ptmx, err := startInPTY(cmd)
	if err != nil {
		return fmt.Errorf("start PTY: %w", err)
	}
	defer ptmx.Close()

	var writeMu sync.Mutex
	send := func(msg wsMessage) {
		data, err := json.Marshal(msg)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.writeText(string(data))
	}
	send(wsMessage{Type: "status", Message: "Shell started"})

	// PTY output → browser
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				send(wsMessage{Type: "output", Data: string(buf[:n])})
			}
			if err != nil {
				return
			}
		}
	}()

	// Browser input → PTY
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			raw, err := conn.readText()
			if err != nil {
				killProcess(cmd)
				return
			}
			var msg wsMessage
			if err := json.Unmarshal([]byte(raw), &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "input":
				if _, err := io.WriteString(ptmx, msg.Data); err != nil {
					killProcess(cmd)
					return
				}
			case "resize":
				if msg.Cols > 0 && msg.Rows > 0 {
					_ = resizePTY(ptmx, msg.Cols, msg.Rows)
				}
			case "close":
				killProcess(cmd)
				return
			}
		}
	}()

	exitCode := 0
	if waitErr := cmd.Wait(); waitErr != nil {
		if exitError, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
		} else {
			exitCode = 1
		}
	}
	send(wsMessage{Type: "exit", Code: exitCode, Message: fmt.Sprintf("Shell exited with code %d", exitCode)})
	_ = conn.close()
	<-done
	return nil
}

func allowedShell(shell string) string {
	if shell == "" {
		shell = "/bin/bash"
	}
	cleaned := filepath.Clean(shell)
	switch cleaned {
	case "/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh", "/bin/zsh", "/usr/bin/zsh":
		if _, err := os.Stat(cleaned); err == nil {
			return cleaned
		}
	}
	for _, candidate := range []string{"/bin/bash", "/usr/bin/bash", "/bin/sh"} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "/bin/sh"
}

func killProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
