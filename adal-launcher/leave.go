//go:build windows

// leave.go — "Log out of this main PC / Connect to another PC" on an Adal
// Companion (asked on 2026-11-18).
//
// The button (Sidebar and Settings, only in a Companion's window:
// components/CompanionSwitchPC.jsx) asks "Are you sure?" and then opens
// 127.0.0.1:47801/forget, the Companion's own online pages, where the
// Companion's online account is kept. That page:
//
//  1. asks the main PC to stop this Companion's online account (POST
//     /api/pc-access/leave on the main PC — only this Companion's own, never
//     the main PC's data or another Companion's); when the main PC cannot be
//     reached, it is asked again later (companion-leave.json);
//  2. clears the pairing: companion.conf, and the online account and the
//     online copy kept by the window;
//  3. opens the "connect to a main PC" page (connect.go), which lists the
//     main PCs that answer on this network and takes a typed address.
//
// Until a PC is chosen there, companion.signed-out keeps the Companion
// (adal-companion.exe) and this program from finding the old main PC again.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const signedOutName = "companion.signed-out"
const leavesName = "companion-leave.json"

// signedOut: this Companion was logged out of its main PC and no other is chosen yet.
func signedOut(root string) bool { return fileExists(filepath.Join(root, signedOutName)) }

var (
	connectOnce sync.Once
	connectUp   bool
)

// ensureConnectPage: the "connect to a main PC" page is served (once); false
// when its port is taken.
func ensureConnectPage(root string) bool {
	connectOnce.Do(func() {
		if connectUp = startConnectPage(root); !connectUp {
			logf("connect page: port %s is taken", connectAddr)
		}
	})
	return connectUp
}

type leave struct {
	Main   string `json:"main"`
	Device string `json:"device"`
	At     int64  `json:"at"`
}

// askMainToForget: the main PC stops this Companion's online account (and its
// key on the main PC's list). done: it did; again: ask later (the main PC did
// not answer, or it has no /leave yet — after its update it has).
func askMainToForget(l leave) (done, again bool) {
	body, _ := json.Marshal(map[string]string{"device": l.Device})
	c := &http.Client{Timeout: 8 * time.Second}
	resp, err := c.Post(strings.TrimRight(l.Main, "/")+"/api/pc-access/leave", "application/json", bytes.NewReader(body))
	if err != nil {
		return false, true
	}
	resp.Body.Close()
	return resp.StatusCode < 300, resp.StatusCode == http.StatusNotFound || resp.StatusCode >= 500
}

var leavesMu sync.Mutex

func readLeaves(root string) []leave {
	var ls []leave
	if b, err := os.ReadFile(filepath.Join(root, leavesName)); err == nil {
		json.Unmarshal(b, &ls)
	}
	return ls
}

func writeLeaves(root string, ls []leave) {
	p := filepath.Join(root, leavesName)
	if len(ls) == 0 {
		os.Remove(p)
		return
	}
	b, _ := json.Marshal(ls)
	os.WriteFile(p, b, 0o644)
}

// retryLeaves: a main PC that was off when this Companion logged out of it is
// asked again every 2 minutes (for 30 days).
func retryLeaves(root string) {
	for {
		leavesMu.Lock()
		var keep []leave
		for _, l := range readLeaves(root) {
			if time.Since(time.Unix(l.At, 0)) > 30*24*time.Hour {
				continue
			}
			done, again := askMainToForget(l)
			if done {
				logf("logged out of %s: its online account for this PC is stopped now", l.Main)
			}
			if again {
				keep = append(keep, l)
			}
		}
		writeLeaves(root, keep)
		leavesMu.Unlock()
		time.Sleep(2 * time.Minute)
	}
}

// forgetMainPC does steps 1 and 2 (see the top). from: the main PC's address
// the button was pressed on ("" in the online pages).
func forgetMainPC(root, from, device string) (revoked bool, main string) {
	main = mainPCURL(root)
	if main == "" {
		main = privateAddr(strings.TrimPrefix(strings.TrimPrefix(from, "http://"), "https://"))
	}
	if main != "" {
		l := leave{Main: main, Device: device, At: time.Now().Unix()}
		var again bool
		revoked, again = askMainToForget(l)
		if again && device != "" {
			leavesMu.Lock()
			writeLeaves(root, append(readLeaves(root), l))
			leavesMu.Unlock()
		}
	}
	os.Remove(filepath.Join(root, "companion.conf"))
	os.Remove(filepath.Join(root, "companion-cloud.json")) // its online account goes too
	os.WriteFile(filepath.Join(root, signedOutName), []byte("Logged out of "+main+" on "+time.Now().Format(time.RFC3339)+".\r\nChoose a main PC in Adal Keep's window (or delete this file to let the Companion search the network again).\r\n"), 0o644)
	logf("logged out of the main PC %s (its online account stopped: %v) — choosing another", main, revoked)
	return
}

// chosenMainPC: a main PC was chosen on the connect page — the sign-out is over.
func chosenMainPC(root string) { os.Remove(filepath.Join(root, signedOutName)) }

// cameFromOwnPage: the /forget page was opened by the Companion's window itself
// (its online pages, or the main PC's page it shows) — not by another website.
func cameFromOwnPage(root string, r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "same-origin" {
		return true
	}
	ref, err := neturl.Parse(r.Referer())
	if err != nil || ref.Host == "" {
		return false
	}
	if ref.Host == onlineAddr {
		return true
	}
	if m, err := neturl.Parse(mainPCURL(root)); err == nil && m.Host != "" && m.Host == ref.Host {
		return true
	}
	return false
}

// foundPCs: the main PCs that answer the Companion's question on this network
// (the same UDP question as adal-companion/discovery.go).
func foundPCs(wait time.Duration) []map[string]string {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		return nil
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(wait))
	targets := []*net.UDPAddr{{IP: net.IPv4bcast, Port: 45454}}
	if ifs, err := net.Interfaces(); err == nil {
		for _, ifc := range ifs {
			if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
				continue
			}
			addrs, _ := ifc.Addrs()
			for _, a := range addrs {
				n, ok := a.(*net.IPNet)
				if !ok || n.IP.To4() == nil || len(n.Mask) != 4 {
					continue
				}
				ip, b := n.IP.To4(), make(net.IP, 4)
				for i := range b {
					b[i] = ip[i] | ^n.Mask[i]
				}
				targets = append(targets, &net.UDPAddr{IP: b, Port: 45454})
			}
		}
	}
	for _, t := range targets {
		conn.WriteToUDP([]byte("ADAL_KEEP_DISCOVER_V1"), t)
	}
	var out []map[string]string
	seen := map[string]bool{}
	buf := make([]byte, 1024)
	for {
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			return out
		}
		parts := strings.Split(strings.TrimSpace(string(buf[:n])), "|")
		if len(parts) < 3 || parts[0] != "ADAL_KEEP_SERVER_V1" {
			continue
		}
		// The reply's own source address first (it is on this network: an
		// advertised Tailscale IP was not, 2026-11-18), then the advertised one.
		ip := from.IP.String()
		if from.IP.To4() == nil || from.IP.IsLoopback() {
			ip = strings.TrimSpace(parts[2])
		}
		u := privateAddr(ip + ":" + strings.TrimSpace(parts[1]))
		if u == "" || seen[u] {
			continue
		}
		seen[u] = true
		name := "Adal Keep"
		if len(parts) > 3 && strings.TrimSpace(parts[3]) != "" {
			name = strings.TrimSpace(parts[3])
		}
		out = append(out, map[string]string{"url": u, "name": name})
	}
}

// forgetRoutes: /forget on the online pages' address (127.0.0.1:47801).
func forgetRoutes(root string, mux *http.ServeMux) {
	mux.HandleFunc("/forget", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodPost {
			// Only the page below (a header another website cannot send unasked).
			if r.Header.Get("X-Adal") != "1" {
				http.Error(w, "no", http.StatusForbidden)
				return
			}
			var in struct{ From, Device string }
			json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&in)
			revoked, main := forgetMainPC(root, in.From, in.Device)
			// The same way in as the first time: the main PC's number
			// (connect.html here; the small page on an install without these pages).
			next := onlineURL + "connect.html"
			if !hasOnlinePages(root) {
				ensureConnectPage(root)
				next = connectURL
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "revoked": revoked, "main": main, "next": next})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		auto := "false"
		if cameFromOwnPage(root, r) {
			auto = "true"
		}
		fmt.Fprint(w, strings.Replace(forgetPage, "__AUTO__", auto, 1))
	})
}

const forgetPage = `<!doctype html><html><head><meta charset="utf-8"><title>Adal Keep</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f8fafc;--card:#fff;--ink:#0f172a;--mute:#64748b;--brand:#0d9488;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#1e293b;--ink:#f1f5f9;--mute:#94a3b8;--bad:#f87171}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}
.c{background:var(--card);max-width:520px;margin:16px;padding:28px;border-radius:16px;box-shadow:0 4px 24px #0002}
h1{font-size:22px;margin:0 0 8px}p{color:var(--mute);margin:8px 0}
button{padding:10px 16px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer;margin-right:8px}
button.no{background:transparent;color:var(--ink);border:1px solid var(--mute)}#err{color:var(--bad)}
</style></head><body><div class="c">
<h1 id="h">Log out of this main PC</h1>
<p id="m">This PC stops working with its main Adal Keep PC, and you can connect it to another one.</p>
<div id="ask" hidden><button id="yes">Yes, log out</button><button class="no" id="no">Cancel</button></div>
<p id="err"></p>
</div><script>
const AUTO = __AUTO__
const q = new URLSearchParams(location.search)
async function run() {
  document.getElementById('ask').hidden = true
  document.getElementById('h').textContent = 'Logging out of the main PC…'
  let device = ''
  try { device = JSON.parse(localStorage.getItem('adal-pc') || 'null')?.cloud?.device || '' } catch (e) {}
  try {
    const r = await (await fetch('/forget', { method: 'POST', headers: { 'X-Adal': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ from: q.get('from') || '', device }) })).json()
    // The online account and the online copy this window kept go too.
    try { localStorage.clear() } catch (e) {}
    try { for (const d of (await indexedDB.databases?.()) || []) if (d.name) indexedDB.deleteDatabase(d.name) } catch (e) {}
    try { for (const k of await caches.keys()) await caches.delete(k) } catch (e) {}
    location.replace(r.next + '?left=' + encodeURIComponent(r.main || '') + '&revoked=' + (r.revoked ? 1 : 0))
  } catch (e) { document.getElementById('err').textContent = 'Could not log out: ' + e }
}
document.getElementById('yes').onclick = run
document.getElementById('no').onclick = () => history.length > 1 ? history.back() : location.replace('/')
if (AUTO) run(); else { document.getElementById('m').textContent += ' Are you sure?'; document.getElementById('ask').hidden = false }
</script></body></html>`
