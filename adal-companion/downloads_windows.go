//go:build windows

package main

import "golang.org/x/sys/windows"

// knownDownloads: where Windows really keeps Downloads. It is often moved to
// D:\ or into OneDrive, and then %USERPROFILE%\Downloads is empty or missing.
func knownDownloads() string {
	p, err := windows.KnownFolderPath(windows.FOLDERID_Downloads, 0)
	if err != nil {
		return ""
	}
	return p
}
