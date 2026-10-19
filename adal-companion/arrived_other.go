//go:build !windows

package main

import (
	"os"
	"time"
)

// arrivedAt: the file's last change (development machines only).
func arrivedAt(path string) (time.Time, bool) {
	st, err := os.Stat(path)
	if err != nil {
		return time.Time{}, false
	}
	return st.ModTime(), true
}
