// steady.go — the Companion's window stays where it is while the main PC is only slow
// (2026-11-25: "it just stutters, it works sometimes and sometimes it doesn't").
//
// One answer later than 2 seconds counted as "the main PC is gone": every look then asked all
// 253 addresses of the network (a busy main PC got slower by it), and the window moved to this
// PC's own copy and back within a minute. Now:
//
//	up    it answers /api/health and is our main PC
//	slow  its port opens, but it does not answer in time (or drops the answer): still there
//	gone  its port does not open
//
// The window leaves the main PC only after several tries in a row over a real while (gone: 45 s
// and 4 tries; slow: 5 minutes and 8 tries), and goes back only once it answered 3 times in a
// row over 20 s. The whole network is asked only when the main PC's own addresses, its id, its
// card and the broadcast all gave nothing, and then with growing pauses (1, 2, 5, 10, 20, 30 min).
// Off: ADAL_STEADY=0 (as before).
package main

import (
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type mainState int

const (
	mainUp mainState = iota
	mainSlow
	mainGone
)

var (
	steadyOff   = os.Getenv("ADAL_STEADY") == "0"
	slowAfter   = time.Duration(envInt("ADAL_SLOW_SECONDS", 300)) * time.Second
	backAfter   = time.Duration(envInt("ADAL_BACK_SECONDS", 20)) * time.Second
	probeAnswer = 8 * time.Second // how long a busy main PC gets to answer
	probeOpen   = 3 * time.Second // how long its port gets to open
)

// windowSteps decides where the window works from one look after the other.
type windowSteps struct {
	own               bool
	bad, gone, ok     int
	badAt, goneAt, up time.Time
}

// step: one look at the main PC → whether the window should work on this PC's own copy.
func (w *windowSteps) step(now time.Time, st mainState) bool {
	if st == mainUp {
		if w.ok == 0 {
			w.up = now
		}
		w.ok++
		w.bad, w.gone = 0, 0
		if steadyOff || (w.ok >= 3 && now.Sub(w.up) >= backAfter) {
			w.own = false
		}
		return w.own
	}
	w.ok = 0
	if w.bad == 0 {
		w.badAt = now
	}
	w.bad++
	if st == mainGone {
		if w.gone == 0 {
			w.goneAt = now
		}
		w.gone++
	} else {
		w.gone = 0 // its port opened: it is there
	}
	switch {
	case steadyOff && now.Sub(w.badAt) >= ownAfter:
		w.own = true
	case w.gone >= 4 && now.Sub(w.goneAt) >= ownAfter:
		w.own = true
	case w.bad >= 8 && now.Sub(w.badAt) >= slowAfter:
		w.own = true
	}
	return w.own
}

var probeClient = &http.Client{Timeout: probeAnswer, Transport: &http.Transport{
	Proxy: nil, DisableKeepAlives: true, DialContext: (&net.Dialer{Timeout: probeOpen}).DialContext,
}}

// portOpens: something listens at u (a slow main PC's port opens at once).
func portOpens(u string) bool {
	p, err := url.Parse(strings.TrimRight(u, "/"))
	if err != nil || p.Host == "" {
		return false
	}
	host := p.Host
	if p.Port() == "" {
		host = net.JoinHostPort(p.Hostname(), "80")
	}
	c, err := net.DialTimeout("tcp", host, probeOpen)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// stateOf: how the main PC at its known addresses is now (never a search of the network).
func (s *standbyRunner) stateOf(cands []string) (mainState, string) {
	best := mainGone
	for _, u := range uniqueURLs(cands) {
		if isLoopbackURL(u) || s.ownAddress(u) {
			continue
		}
		if got := s.realMainAt([]string{u}); got != "" {
			return mainUp, got
		}
		// Not "our main PC" for sure (another agency's, a Companion) is not "slow".
		if wasBusy(u) && portOpens(u) {
			best = mainSlow
		}
	}
	return best, ""
}

// Addresses whose last look was no answer (slow, dropped), not a "no".
var (
	busyMu sync.Mutex
	busyAt = map[string]time.Time{}
)

func markBusy(u string, busy bool) {
	busyMu.Lock()
	defer busyMu.Unlock()
	if busy {
		busyAt[strings.TrimRight(u, "/")] = time.Now()
	} else {
		delete(busyAt, strings.TrimRight(u, "/"))
	}
}
func wasBusy(u string) bool {
	busyMu.Lock()
	defer busyMu.Unlock()
	t, ok := busyAt[strings.TrimRight(u, "/")]
	return ok && time.Since(t) < time.Minute
}

func uniqueURLs(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, u := range in {
		if u = strings.TrimRight(u, "/"); u != "" && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	return out
}

// The number a main PC said yes to is asked again after a while, not at every look
// (a busy main PC answered one more question each time).
var (
	numberMu  sync.Mutex
	numberYes = map[string]time.Time{}
)

func numberKnown(u, num string) bool {
	k := strings.TrimRight(u, "/") + "|" + num
	numberMu.Lock()
	t, ok := numberYes[k]
	numberMu.Unlock()
	if ok && !steadyOff && time.Since(t) < 2*time.Minute {
		return true
	}
	if !numberCheck(u, num) {
		if wasUnknown(u) {
			markBusy(u, true)
		}
		return false
	}
	numberMu.Lock()
	numberYes[k] = time.Now()
	numberMu.Unlock()
	return true
}

// ── The sweep of the whole network ──────────────────────────────────────────

const sweepGrace = 4 * time.Minute

var sweepPauses = []time.Duration{time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 20 * time.Minute, 30 * time.Minute}
var sweep = struct {
	mu   sync.Mutex
	n    int
	next time.Time
	net  string
	seen time.Time // the main PC answered here last
}{}

// sweepDue: may every address of the network be asked now? Another network (a new address
// of this PC) starts again at once.
func sweepDue(now time.Time, network string) bool {
	if steadyOff {
		return true
	}
	sweep.mu.Lock()
	defer sweep.mu.Unlock()
	if network != sweep.net {
		sweep.n, sweep.next, sweep.net, sweep.seen = 0, time.Time{}, network, time.Time{}
	}
	// It answered a few minutes ago on this very network: a restart, not a move (2026-11-25: two
	// sweeps while Main restarted).
	if now.Sub(sweep.seen) < sweepGrace {
		return false
	}
	if now.Before(sweep.next) {
		return false
	}
	p := sweepPauses[min(sweep.n, len(sweepPauses)-1)]
	sweep.n++
	sweep.next = now.Add(p)
	log.Printf("🔍 The whole network is asked once now; again in %s at the soonest", p)
	return true
}

// sweepFound: the main PC is known: the pauses start from the beginning next time.
func sweepFound() {
	sweep.mu.Lock()
	sweep.n, sweep.next, sweep.seen = 0, time.Time{}, time.Now()
	sweep.mu.Unlock()
}

func networkNow() string {
	var out []string
	for _, ip := range localIPs() {
		if v4 := ip.To4(); v4 != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
			out = append(out, v4.Mask(net.CIDRMask(24, 32)).String())
		}
	}
	return strings.Join(out, ",")
}
