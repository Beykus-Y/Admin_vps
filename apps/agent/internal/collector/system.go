package collector

import (
	"context"
	stdnet "net"
	"os"
	"runtime"
	"strings"

	"github.com/filincontrol/agent/internal/client"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
)

func CollectSystem(ctx context.Context) (*client.SnapshotSystem, error) {
	hostname, _ := os.Hostname()
	hostInfo, err := host.InfoWithContext(ctx)
	if err != nil {
		return nil, err
	}

	cpuModel := ""
	if cpuInfos, err := cpu.InfoWithContext(ctx); err == nil && len(cpuInfos) > 0 {
		cpuModel = cpuInfos[0].ModelName
	}
	cpuCores, _ := cpu.CountsWithContext(ctx, true)

	return &client.SnapshotSystem{
		Hostname:      hostname,
		OS:            detectPrettyOS(hostInfo.Platform, hostInfo.PlatformVersion),
		Arch:          runtime.GOARCH,
		UptimeSeconds: int64(hostInfo.Uptime),
		Kernel:        hostInfo.KernelVersion,
		CPUModel:      cpuModel,
		CPUCores:      cpuCores,
		LocalIPs:      collectLocalIPs(),
	}, nil
}

func detectPrettyOS(platform, version string) string {
	data, err := os.ReadFile("/etc/os-release")
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	return strings.TrimSpace(platform + " " + version)
}

func collectLocalIPs() []string {
	interfaces, err := stdnet.Interfaces()
	if err != nil {
		return []string{}
	}
	result := []string{}
	for _, iface := range interfaces {
		name := strings.ToLower(iface.Name)
		if strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "cni") || strings.HasPrefix(name, "flannel") {
			continue
		}
		if iface.Flags&stdnet.FlagUp == 0 || iface.Flags&stdnet.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			ip, _, err := stdnet.ParseCIDR(address.String())
			if err != nil || ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() {
				continue
			}
			result = append(result, ip.String())
			if len(result) >= 8 {
				return result
			}
		}
	}
	return result
}
