package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type opened struct {
	o       windowOpener
	dir     string
	log     []string
	resort  int
	showing bool
	focused int
	held    int // how many looks the old process is still there
}

// A fake browser: a script that writes down its start and ends as told, one code a line; then it goes on.
func fake(t *testing.T, name string, codes ...int) (*opened, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake browser is a shell script")
	}
	dir := t.TempDir()
	x := &opened{dir: dir}
	b := x.add(t, name, codes...)
	x.o = windowOpener{
		browsers: []string{b}, args: []string{"--app=x"},
		focus: func() bool {
			if x.showing {
				x.focused++
			}
			return x.showing
		},
		holders: func() []uint32 {
			if x.held > 0 {
				x.held--
				return []uint32{7}
			}
			return nil
		},
		lastResort: func() { x.resort++ },
		log:        func(f string, a ...any) { x.log = append(x.log, fmt.Sprintf(f, a...)) },
		wait:       2 * time.Second, shown: 300 * time.Millisecond, step: 10 * time.Millisecond,
	}
	return x, b
}

func (x *opened) add(t *testing.T, name string, codes ...int) string {
	t.Helper()
	b := filepath.Join(x.dir, name)
	s := "#!/bin/sh\necho x >> " + b + ".starts\nn=$(wc -l < " + b + ".starts)\ncase $n in\n"
	for i, c := range codes {
		s += fmt.Sprintf("%d) exit %d;;\n", i+1, c)
	}
	if err := os.WriteFile(b, []byte(s+"esac\nexec sleep 2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return b
}

func starts(b string) int {
	s, _ := os.ReadFile(b + ".starts")
	return strings.Count(string(s), "x")
}

func TestProfileInUseTwiceThenItOpens(t *testing.T) {
	x, adal := fake(t, "AdalBrowser", 21, 21)
	chrome := x.add(t, "chrome")
	x.o.browsers = append(x.o.browsers, chrome)
	x.held = 5
	if !x.o.open() || starts(adal) != 3 || starts(chrome) != 0 || x.resort != 0 {
		t.Fatal(starts(adal), starts(chrome), x.resort, x.log)
	}
	if x.held != 0 {
		t.Fatal("tried again before the old process was gone")
	}
}

func TestProfileStaysInUse(t *testing.T) {
	codes := make([]int, 300)
	for i := range codes {
		codes[i] = 21
	}
	x, adal := fake(t, "AdalBrowser", codes...)
	chrome := x.add(t, "chrome")
	x.o.browsers = append(x.o.browsers, chrome)
	x.held = 1 << 30
	t0 := time.Now()
	if x.o.open() || starts(chrome) != 0 || x.resort != 1 || starts(adal) != 2 {
		t.Fatal(starts(adal), starts(chrome), x.resort, x.log)
	}
	if d := time.Since(t0); d < 2*time.Second || d > 4*time.Second {
		t.Fatal(d)
	}
	if l := strings.Join(x.log, "\n"); !strings.Contains(l, "still in use") || !strings.Contains(l, "[7]") {
		t.Fatal(l)
	}
	// Not a person's click: nothing else opens.
	x.o.lastResort, x.o.wait = nil, 50*time.Millisecond
	if x.o.open() || starts(chrome) != 0 || x.resort != 1 {
		t.Fatal("opened by itself")
	}
}

func TestWindowThereWhileWaitingIsTheOne(t *testing.T) {
	x, adal := fake(t, "AdalBrowser", 21)
	x.held = 1 << 30
	h := x.o.holders
	n := 0
	x.o.holders = func() []uint32 {
		if n++; n == 5 {
			x.showing = true // another click's window
		}
		return h()
	}
	if !x.o.open() || starts(adal) != 1 || x.focused == 0 || x.resort != 0 {
		t.Fatal(starts(adal), x.focused, x.resort)
	}
}

func TestSeenAndClosedWithXStaysClosed(t *testing.T) {
	x, adal := fake(t, "AdalBrowser")
	chrome := x.add(t, "chrome")
	x.o.browsers = append(x.o.browsers, chrome)
	x.showing = true // shows at once: nothing is looked after any more, whatever comes of it
	if !x.o.open() || starts(adal) > 1 || starts(chrome) != 0 || x.resort != 0 {
		t.Fatal(starts(adal), starts(chrome), x.resort)
	}
}

func TestABrokenBrowserIsFollowedByTheNext(t *testing.T) {
	x, adal := fake(t, "AdalBrowser", 1)
	chrome := x.add(t, "chrome")
	x.o.browsers = append(x.o.browsers, chrome)
	if !x.o.open() || starts(adal) != 1 || starts(chrome) != 1 || x.resort != 0 {
		t.Fatal(starts(adal), starts(chrome), x.log)
	}
}

func TestProfileWaitOff(t *testing.T) {
	x, adal := fake(t, "AdalBrowser", 21)
	chrome := x.add(t, "chrome")
	x.o.browsers = append(x.o.browsers, chrome)
	t.Setenv("ADAL_PROFILE_WAIT", "0")
	if x.o.wait = profileWait(); x.o.wait != 0 {
		t.Fatal(x.o.wait)
	}
	if !x.o.open() || starts(adal) != 1 || starts(chrome) != 1 {
		t.Fatal("as before")
	}
}

func TestHoldsProfile(t *testing.T) {
	p := `C:\Adal Keep\backend\data\ui-profile`
	for c, want := range map[string]bool{
		`"C:\x\AdalBrowser.exe" "--user-data-dir=C:\Adal Keep\backend\data\ui-profile" --app=x`:  true,
		`AdalBrowser.exe --user-data-dir="c:\adal keep\backend\data\UI-profile" --app=x`:         true,
		`AdalBrowser.exe --type=renderer --user-data-dir="C:\Adal Keep\backend\data\ui-profile"`: false,
		`AdalBrowser.exe "--user-data-dir=C:\Adal Keep\backend\data\ui-profile-2"`:               false,
		`AdalBrowser.exe "--user-data-dir=C:\Adal Keep\backend\data\browser-profile"`:            false,
	} {
		if holdsProfile(c, p) != want {
			t.Error(c)
		}
	}
}
