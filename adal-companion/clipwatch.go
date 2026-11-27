// clipwatch.go — the double "C" screen crop on an Adal Companion (the owner, 2026-11-27: "double C
// doesn't work on the Companion").
//
// The crop's watcher (adal-clip.exe) was started only by an Adal Keep server (backend
// services/screenClip.js). A Companion runs no server of its own while the main PC answers
// (standby.go: only when it stands in), so nothing watched the keyboard there: the page's
// own double C then asked the main PC to crop, and the main PC said "The double C is not
// running on this computer".
//
// Now this program starts the watcher itself, while this PC does not stand in. The watcher
// sends through this program's door to the main PC (/local/main/…, mainproxy.go: with this
// Companion's key), so the main PC hands the picture to this PC's own pages only (backend
// services/clipRelay.js), and says every 45 s that the watcher runs (the page then leaves
// double C to it). Standing in: the watcher here stops; the server started then has its own.
// One watcher a PC (its own lock): when a server's watcher runs already, this one just ends.
// Off: ADAL_COMPANION_CLIP=0.
package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"time"
)

var clipName = regexp.MustCompile(`(?i)^adal-clip(?:-(\d+))?\.exe$`)

// newestClip: the newest adal-clip(-N).exe in these folders (each version has its own name, screenClip.js).
func newestClip(dirs ...string) string {
	type cand struct {
		path string
		n    int
	}
	var all []cand
	for _, d := range dirs {
		es, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range es {
			if m := clipName.FindStringSubmatch(e.Name()); m != nil && !e.IsDir() {
				n, _ := strconv.Atoi(m[1])
				all = append(all, cand{filepath.Join(d, e.Name()), n})
			}
		}
	}
	if len(all) == 0 {
		return ""
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].n > all[j].n })
	return all[0].path
}

// clipDirs: where this Companion keeps the server's files (the server in waiting first, standby.go).
func clipDirs(root string) []string {
	return []string{filepath.Join(serverBackend(root), "bin"), filepath.Join(root, "backend", "bin"), filepath.Join(root, "bin")}
}

// clipArgs: without --beat for an older watcher that does not know it (it then ends at once with an error).
func clipArgs(beat bool) []string {
	a := []string{"--server", fmt.Sprintf("http://127.0.0.1:%d/local/main", lanHTTPPort), "--parent", strconv.Itoa(os.Getpid())}
	if beat {
		a = append(a, "--beat", "45s")
	}
	return a
}

// clipWanted: the watcher here only while the main PC is the one to send to.
func clipWanted() bool {
	return os.Getenv("ADAL_COMPANION_CLIP") != "0" && !standbyActing() && hostServer != ""
}

func startClipWatch(root string) {
	if os.Getenv("ADAL_COMPANION_CLIP") == "0" {
		return
	}
	go func() {
		var cmd *exec.Cmd
		done := make(chan time.Duration, 1) // how long to wait before starting it again
		said, beat := false, true
		for {
			if cmd == nil && clipWanted() {
				if exe := newestClip(clipDirs(root)...); exe != "" {
					c := exec.Command(exe, clipArgs(beat)...)
					hideCmd(c)
					if err := c.Start(); err != nil {
						log.Printf("✂ the double-C watcher could not start: %v", err)
					} else {
						cmd = c
						began := time.Now()
						go func() {
							err := c.Wait()
							quick := time.Since(began) < 5*time.Second
							if quick && err != nil && beat { // an older watcher: no --beat
								beat = false
								done <- time.Second
								return
							}
							// Ended at once: another watcher runs on this PC (a server's) — look again later.
							if quick {
								done <- 2 * time.Minute
							} else {
								done <- 15 * time.Second
							}
						}()
						if !said {
							log.Printf("✂ double C crops the screen on this PC (%s → the main PC)", filepath.Base(exe))
							said = true
						}
					}
				}
			} else if cmd != nil && !clipWanted() && cmd.Process != nil {
				cmd.Process.Kill() // standing in: the server's own watcher takes over
			}
			select {
			case wait := <-done:
				cmd = nil
				time.Sleep(wait)
			case <-time.After(15 * time.Second):
			}
		}
	}()
}
