package main

// folders.go — which folders the Companion looks after. A folder can appear
// or come back later (Telegram's, a USB-moved Downloads), and Windows can lose
// change notices when many files land at once, so every 30 seconds the list is
// checked again and the folders are swept for files that were missed.

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

const sweepEvery = 30 * time.Second

var relevantExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".bmp": true,
	".pdf": true, ".docx": true, ".xlsx": true,
}

func isRelevant(name string) bool {
	return relevantExt[strings.ToLower(filepath.Ext(name))]
}

// candidateFolders: Windows' own Downloads first, then the usual places.
func candidateFolders() []string {
	home, _ := os.UserHomeDir()
	var list []string
	for _, d := range []string{
		knownDownloads(),
		filepath.Join(home, "Downloads"),
		filepath.Join(home, "OneDrive", "Downloads"),
		filepath.Join(home, "Desktop"),
		filepath.Join(home, "OneDrive", "Desktop"), // Desktop kept in OneDrive
	} {
		if d == "" {
			continue
		}
		list = append(list, d)
		if strings.EqualFold(filepath.Base(d), "Downloads") || d == knownDownloads() {
			list = append(list, filepath.Join(d, "Telegram Desktop"))
		}
	}
	seen := map[string]bool{}
	var out []string
	for _, d := range list {
		key := strings.ToLower(filepath.Clean(d))
		if !seen[key] {
			seen[key] = true
			out = append(out, d)
		}
	}
	return out
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// watchFolders adds every folder that exists and is not watched yet. A folder
// that went away is dropped, so it is added again when it comes back.
func watchFolders(w *fsnotify.Watcher) {
	var live []string
	for _, d := range watchDirs {
		if isDir(d) {
			live = append(live, d)
		} else {
			w.Remove(d)
			log.Printf("⚠️ Folder is gone, waiting for it: %s", d)
		}
	}
	watchDirs = live
	for _, d := range candidateFolders() {
		if !isDir(d) || contains(watchDirs, d) {
			continue
		}
		if err := w.Add(d); err != nil {
			log.Printf("⚠️ Cannot watch %s: %v", d, err)
			continue
		}
		watchDirs = append(watchDirs, d)
		log.Printf("   📁 Watching: %s", d)
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// sweptOld: files a sweep already found to be older than the start, by
// size and change time. The next sweeps skip them without opening each one
// (arrivedAt opens the file): a Downloads folder with thousands of old files
// was opened file by file every 30 seconds. A file that comes in again under
// the same name has another time or size, and the folder watch sees it anyway.
type sweepStamp struct {
	size int64
	mod  time.Time
}

var sweptOld = map[string]sweepStamp{}

// missedFiles: files that arrived after `since` and were never handled.
func missedFiles(dirs []string, since time.Time, handled map[string]time.Time) []string {
	var out []string
	keep := map[string]sweepStamp{} // only what is still there stays remembered
	for _, d := range dirs {
		entries, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !isRelevant(e.Name()) {
				continue
			}
			p := filepath.Join(d, e.Name())
			if _, done := handled[p]; done {
				continue
			}
			// On Windows the folder listing already carries size and time.
			info, ierr := e.Info()
			if ierr == nil {
				if s, seen := sweptOld[p]; seen && s.size == info.Size() && s.mod.Equal(info.ModTime()) {
					keep[p] = s
					continue
				}
			}
			at, ok := arrivedAt(p)
			if !ok {
				if ierr != nil {
					continue
				}
				at = info.ModTime()
			}
			if at.After(since) {
				out = append(out, p)
			} else if ierr == nil {
				keep[p] = sweepStamp{info.Size(), info.ModTime()}
			}
		}
	}
	sweptOld = keep
	return out
}
