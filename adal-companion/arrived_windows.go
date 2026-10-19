//go:build windows

package main

import (
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// arrivedAt: when the file got into its folder — created there, or moved or
// renamed in (NTFS change time). Reading a file (antivirus, thumbnails) does
// not change either.
func arrivedAt(path string) (time.Time, bool) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return time.Time{}, false
	}
	h, err := windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return time.Time{}, false
	}
	defer windows.CloseHandle(h)
	var info struct {
		CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
		FileAttributes                                          uint32
		_                                                       uint32
	}
	if err := windows.GetFileInformationByHandleEx(h, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return time.Time{}, false
	}
	t := info.CreationTime
	if info.ChangeTime > t {
		t = info.ChangeTime
	}
	return time.Unix(0, (t-116444736000000000)*100), true
}
