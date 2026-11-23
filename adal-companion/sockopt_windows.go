//go:build windows

package main

import "syscall"

// setSockoptBroadcast turns on SO_BROADCAST for a socket handle.
func setSockoptBroadcast(fd uintptr) error {
	return syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
}

// setSockoptReuse: SO_REUSEADDR, so the Companion and Adal Keep on the same PC both hear :45454.
func setSockoptReuse(fd uintptr) error {
	return syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
}
