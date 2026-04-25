//go:build linux

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// Linux ioctl constants for PTY management (same on all Linux architectures)
const (
	ioctlTIOCGPTN   uintptr = 0x80045430 // get PTY slave number
	ioctlTIOCSPTLCK uintptr = 0x40045431 // unlock PTY slave
	ioctlTIOCSWINSZ uintptr = 0x5414     // set window size
)

type winsize struct {
	Rows uint16
	Cols uint16
	X    uint16
	Y    uint16
}

func ptyIoctl(fd uintptr, req uintptr, arg unsafe.Pointer) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, req, uintptr(arg))
	if errno != 0 {
		return errno
	}
	return nil
}

func openPTY() (master, slave *os.File, err error) {
	master, err = os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		if err != nil {
			master.Close()
		}
	}()

	var ptn uint32
	if err = ptyIoctl(master.Fd(), ioctlTIOCGPTN, unsafe.Pointer(&ptn)); err != nil {
		return nil, nil, fmt.Errorf("TIOCGPTN: %w", err)
	}

	var lock int32 // zero = unlock
	if err = ptyIoctl(master.Fd(), ioctlTIOCSPTLCK, unsafe.Pointer(&lock)); err != nil {
		return nil, nil, fmt.Errorf("TIOCSPTLCK: %w", err)
	}

	slavePath := fmt.Sprintf("/dev/pts/%d", ptn)
	slave, err = os.OpenFile(slavePath, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	return master, slave, nil
}

// startInPTY starts cmd inside a new PTY and returns the master fd.
// The caller owns the master fd and must close it.
func startInPTY(cmd *exec.Cmd) (*os.File, error) {
	master, slave, err := openPTY()
	if err != nil {
		return nil, err
	}
	defer slave.Close()

	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
		Ctty:   int(slave.Fd()),
	}
	if err := cmd.Start(); err != nil {
		master.Close()
		return nil, err
	}
	return master, nil
}

func resizePTY(master *os.File, cols, rows int) error {
	ws := winsize{Rows: uint16(rows), Cols: uint16(cols)}
	return ptyIoctl(master.Fd(), ioctlTIOCSWINSZ, unsafe.Pointer(&ws))
}
