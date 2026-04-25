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

	cmd := terminalCommand(shell)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	var writeMu sync.Mutex
	send := func(message wsMessage) {
		data, err := json.Marshal(message)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.writeText(string(data))
	}
	send(wsMessage{Type: "status", Message: "Shell started"})

	done := make(chan struct{})
	go copyOutput(stdout, send)
	go copyOutput(stderr, send)
	go func() {
		defer close(done)
		for {
			raw, err := conn.readText()
			if err != nil {
				killProcess(cmd)
				return
			}
			var message wsMessage
			if err := json.Unmarshal([]byte(raw), &message); err != nil {
				continue
			}
			switch message.Type {
			case "input":
				if _, err := io.WriteString(stdin, message.Data); err != nil {
					killProcess(cmd)
					return
				}
			case "close":
				killProcess(cmd)
				return
			case "resize":
				continue
			}
		}
	}()

	waitErr := cmd.Wait()
	exitCode := 0
	if waitErr != nil {
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

func copyOutput(reader io.Reader, send func(wsMessage)) {
	buffer := make([]byte, 4096)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			send(wsMessage{Type: "output", Data: string(buffer[:n])})
		}
		if err != nil {
			return
		}
	}
}

func terminalCommand(shell string) *exec.Cmd {
	shell = allowedShell(shell)
	if scriptPath, err := exec.LookPath("script"); err == nil {
		return exec.Command(scriptPath, "-qfec", shell, "/dev/null")
	}
	return exec.Command(shell, "-i")
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
