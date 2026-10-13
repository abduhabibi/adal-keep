//go:build windows

package main

import "syscall"

// setSockoptBroadcast turns on SO_BROADCAST for a socket handle.
func setSockoptBroadcast(fd uintptr) error {
	return syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
}
