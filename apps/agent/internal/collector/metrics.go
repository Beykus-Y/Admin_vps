package collector

import (
	"context"
	"time"

	"github.com/filincontrol/agent/internal/client"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

func CollectMetrics(ctx context.Context) (*client.SnapshotMetrics, error) {
	cpuPcts, err := cpu.PercentWithContext(ctx, time.Second, false)
	if err != nil || len(cpuPcts) == 0 {
		cpuPcts = []float64{0}
	}

	vm, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return nil, err
	}

	diskStat, err := disk.UsageWithContext(ctx, "/")
	if err != nil {
		return nil, err
	}

	avg, _ := load.AvgWithContext(ctx)
	if avg == nil {
		avg = &load.AvgStat{}
	}

	var rxBytes, txBytes int64
	ifaces, _ := net.IOCountersWithContext(ctx, false)
	if len(ifaces) > 0 {
		rxBytes = int64(ifaces[0].BytesRecv)
		txBytes = int64(ifaces[0].BytesSent)
	}

	return &client.SnapshotMetrics{
		CPUPercent:     cpuPcts[0],
		RAMUsedMB:      int64(vm.Used / 1024 / 1024),
		RAMTotalMB:     int64(vm.Total / 1024 / 1024),
		DiskUsedGB:     float64(diskStat.Used) / 1e9,
		DiskTotalGB:    float64(diskStat.Total) / 1e9,
		Load1:          avg.Load1,
		Load5:          avg.Load5,
		Load15:         avg.Load15,
		NetworkRXBytes: rxBytes,
		NetworkTXBytes: txBytes,
	}, nil
}
