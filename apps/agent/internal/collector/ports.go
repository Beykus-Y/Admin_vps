package collector

import (
	"bufio"
	"bytes"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	agentclient "github.com/filincontrol/agent/internal/client"
)

// CollectPorts parses `ss -tulpn` output on Linux.
func CollectPorts() ([]agentclient.SnapshotPort, error) {
	out, err := exec.Command("ss", "-H", "-tulpn").Output()
	if err != nil {
		return nil, fmt.Errorf("ss failed: %w", err)
	}
	return parseSSOutput(out), nil
}

func parseSSOutput(data []byte) []agentclient.SnapshotPort {
	ports := []agentclient.SnapshotPort{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		// skip header
		if strings.HasPrefix(line, "Netid") || strings.HasPrefix(line, "State") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		proto := strings.ToLower(fields[0])
		if proto != "tcp" && proto != "udp" {
			continue
		}
		// Local Address:Port is fields[4]
		localAddr := fields[4]
		listenIP, portStr := splitAddr(localAddr)
		portNum, err := strconv.Atoi(portStr)
		if err != nil {
			continue
		}

		sp := agentclient.SnapshotPort{
			Protocol: proto,
			Port:     portNum,
			ListenIP: listenIP,
		}

		// Process info in last field: users:(("caddy",pid=1234,fd=6))
		if len(fields) >= 6 {
			last := fields[len(fields)-1]
			if strings.HasPrefix(last, "users:") {
				sp.ProcessName, sp.PID = parseProcessInfo(last)
			}
		}
		ports = append(ports, sp)
	}
	return ports
}

func splitAddr(addr string) (ip, port string) {
	// IPv6 looks like [::]:443 or *:443
	if strings.HasPrefix(addr, "[") {
		// [::1]:80
		parts := strings.SplitN(addr, "]:", 2)
		if len(parts) == 2 {
			return strings.TrimPrefix(parts[0], "["), parts[1]
		}
	}
	idx := strings.LastIndex(addr, ":")
	if idx < 0 {
		return addr, ""
	}
	ip = addr[:idx]
	if ip == "*" || ip == "0.0.0.0" {
		ip = "0.0.0.0"
	}
	return ip, addr[idx+1:]
}

func parseProcessInfo(s string) (name string, pid int) {
	// users:(("caddy",pid=1234,fd=6))
	s = strings.TrimPrefix(s, "users:((")
	s = strings.TrimSuffix(s, "))")
	parts := strings.Split(s, ",")
	if len(parts) < 2 {
		return "", 0
	}
	name = strings.Trim(parts[0], `"`)
	for _, p := range parts[1:] {
		if strings.HasPrefix(p, "pid=") {
			pid, _ = strconv.Atoi(strings.TrimPrefix(p, "pid="))
		}
	}
	return
}
