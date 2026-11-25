//go:build !windows

package main

import "syscall"

func diskFree(dir string) int64 {
	var s syscall.Statfs_t
	if syscall.Statfs(dir, &s) != nil {
		return 0
	}
	return int64(s.Bavail) * int64(s.Bsize)
}
