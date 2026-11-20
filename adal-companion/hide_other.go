//go:build !windows

package main

import "os/exec"

func hideCmd(cmd *exec.Cmd) {}

func cmdLine(line string) *exec.Cmd { return exec.Command("sh", "-c", line) }
