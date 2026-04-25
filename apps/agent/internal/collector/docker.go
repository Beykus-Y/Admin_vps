package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	agentclient "github.com/filincontrol/agent/internal/client"
)

func CollectContainers(ctx context.Context) ([]agentclient.SnapshotContainer, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("docker connect: %w", err)
	}
	defer cli.Close()

	containers, err := cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("container list: %w", err)
	}

	statsMap := map[string]*dockertypes.StatsJSON{}
	for _, c := range containers {
		if c.State != "running" {
			continue
		}
		resp, err := cli.ContainerStatsOneShot(ctx, c.ID)
		if err != nil {
			continue
		}
		var stats dockertypes.StatsJSON
		if err := json.NewDecoder(resp.Body).Decode(&stats); err == nil {
			statsMap[c.ID] = &stats
		}
		resp.Body.Close()
	}

	var result []agentclient.SnapshotContainer
	for _, c := range containers {
		name := c.ID[:12]
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}

		sc := agentclient.SnapshotContainer{
			ContainerID: c.ID[:12],
			Name:        name,
			Image:       c.Image,
			Status:      c.Status,
			State:       c.State,
			Labels:      c.Labels,
		}

		for _, p := range c.Ports {
			if p.PublicPort > 0 {
				sc.Ports = append(sc.Ports, fmt.Sprintf("%d:%d/%s", p.PublicPort, p.PrivatePort, p.Type))
			}
		}
		for netName := range c.NetworkSettings.Networks {
			sc.Networks = append(sc.Networks, netName)
		}
		for _, m := range c.Mounts {
			sc.Mounts = append(sc.Mounts, fmt.Sprintf("%s:%s", m.Source, m.Destination))
		}

		if stats, ok := statsMap[c.ID]; ok {
			cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage)
			systemDelta := float64(stats.CPUStats.SystemUsage - stats.PreCPUStats.SystemUsage)
			numCPU := float64(len(stats.CPUStats.CPUUsage.PercpuUsage))
			if systemDelta > 0 && numCPU > 0 {
				sc.CPUPercent = (cpuDelta / systemDelta) * numCPU * 100.0
			}
			sc.RAMMB = float64(stats.MemoryStats.Usage) / 1024 / 1024
		}

		result = append(result, sc)
	}
	return result, nil
}
