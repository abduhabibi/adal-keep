//go:build !windows

package main

// protect: elsewhere (tests, a Linux Companion) the file itself is readable
// by this user only (replica.go writes it 0600); nothing more is added.
func protect(plain []byte) ([]byte, error) { return append([]byte{}, plain...), nil }

func unprotect(sealed []byte) ([]byte, error) { return append([]byte{}, sealed...), nil }
