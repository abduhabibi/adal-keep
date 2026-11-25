// openwindow.go — a browser that says its profile is in use (exit 21) is waited for, not replaced.
//
// Main, 2026-11-25 17:10: a click; Adal Browser and then Chrome "stopped at once: exit status 21" (Chromium:
// profile in use — most likely the last window was still closing) and Adal Keep opened in Firefox. So: on 21 the
// old processes of this profile are waited for (up to 8 s) and the SAME browser is tried again; another
// browser is never given a profile in use. The default browser is the last resort of a person's click only.
// One window: looked for before every start; nothing is started any more once it was seen (also after X).
//
// Off: ADAL_PROFILE_WAIT=0 (as before: 21 is like any other failure). Other numbers: the seconds to wait.
package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const profileInUse = 21 // Chromium's RESULT_CODE_PROFILE_IN_USE

type windowOpener struct {
	browsers   []string
	args       []string
	focus      func() bool     // the window is there: in front
	holders    func() []uint32 // the processes that have this profile open
	lastResort func()          // the default browser (nil: not on a person's click just now)
	log        func(string, ...any)
	wait       time.Duration // for a profile in use
	shown      time.Duration // how long a window that does not show yet is waited for
	step       time.Duration
}

func profileWait() time.Duration {
	if n, err := strconv.Atoi(os.Getenv("ADAL_PROFILE_WAIT")); err == nil && n >= 0 && n <= 60 {
		return time.Duration(n) * time.Second
	}
	return 8 * time.Second
}

// open: true when the window is there (or on its way).
func (o windowOpener) open() bool {
	inUse := false
	for _, b := range o.browsers {
		err := o.start(b)
		if o.wait > 0 && exitCode(err) == profileInUse {
			err = o.again(b)
			inUse = exitCode(err) == profileInUse
		}
		if err == nil {
			return true
		}
		if inUse {
			break // the profile is in use: never another browser with it
		}
	}
	if o.focus() {
		return true
	}
	if o.lastResort == nil {
		o.log("no browser could open")
		return false
	}
	if inUse {
		o.log("the window's profile stayed in use — using the default browser")
	} else {
		o.log("no browser could open — using the default one")
	}
	o.lastResort()
	return false
}

// again: the same browser, when the old processes of the profile are gone (or the time is up).
func (o windowOpener) again(b string) error {
	end := time.Now().Add(o.wait)
	was := o.holders()
	o.log("%s: its profile is in use (processes %v) — waiting for it", filepath.Base(b), was)
	for pause := 2 * o.step; ; pause = 4 * o.step {
		// The processes first, then a moment for Windows to let go of the files.
		for len(o.holders()) > 0 && time.Now().Before(end) {
			if o.focus() {
				return nil
			}
			time.Sleep(o.step)
		}
		time.Sleep(pause)
		if o.focus() {
			return nil
		}
		last := !time.Now().Before(end)
		err := o.start(b)
		if exitCode(err) != profileInUse {
			return err
		}
		if last {
			o.log("%s: its profile is still in use after %s (processes %v): exit status 21", filepath.Base(b), o.wait, o.holders())
			return err
		}
	}
}

// start: nil when the window shows, the browser goes on, or another one took it (a clean end).
func (o windowOpener) start(b string) error {
	cmd := exec.Command(b, o.args...)
	if err := cmd.Start(); err != nil {
		o.log("could not start %s: %v", b, err)
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	for end := time.Now().Add(o.shown); ; {
		select {
		case err := <-done:
			if err != nil {
				o.log("%s stopped at once: %v", filepath.Base(b), err)
				return err
			}
		case <-time.After(o.step):
			if !o.focus() && time.Now().Before(end) {
				continue
			}
		}
		o.log("opened in %s (app window)", filepath.Base(b))
		return nil
	}
}

func exitCode(err error) int {
	var e *exec.ExitError
	if errors.As(err, &e) {
		return e.ExitCode()
	}
	return 0
}

// holdsProfile: a command line is the browser itself (not one of its helpers) with this very profile.
func holdsProfile(cmdline, profile string) bool {
	c, p := strings.ToLower(cmdline), strings.ToLower("--user-data-dir="+profile)
	if strings.Contains(c, "--type=") {
		return false
	}
	c = strings.ReplaceAll(c, `"`, "\x00")
	for _, q := range []string{p, strings.Replace(p, "=", "=\x00", 1)} {
		if i := strings.Index(c, q); i >= 0 {
			if rest := c[i+len(q):]; rest == "" || rest[0] == ' ' || rest[0] == 0 {
				return true
			}
		}
	}
	return false
}
