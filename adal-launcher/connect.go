//go:build windows

// connect.go — the "Connect to the main PC" page on an employee PC.
//
// Since 2026-11-19 a Companion always joins by typing the main PC's number
// (5 digits, in the main PC's Settings → Main PC, e.g. 47040): the first time
// and after "Log out of this main PC". The network search only finds the
// candidates; the main PC that says the number is its own is the one opened,
// and the window comes in there with that same number (#adal_number).
//
// When the main PC cannot be found, AdalKeep.exe opens this small page
// (served only to this PC, on 127.0.0.1) instead of an error box. It shows
// that the search goes on, opens Adal Keep by itself the moment the main PC
// answers, and lets the person type the main PC's address — the office one
// shown on the main PC in Settings → Main PC, or its Tailscale address
// (100.x.x.x) from home or another branch. The typed address is saved in
// companion.conf, where the Companion and AdalKeep.exe both read it.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const connectAddr = "127.0.0.1:47800"

var connectURL = "http://" + connectAddr + "/"

// normalizeMainURL: "192.168.1.5" → "http://192.168.1.5:4000".
func normalizeMainURL(in string) string {
	s := strings.TrimSpace(in)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	s = strings.TrimRight(s, "/")
	rest := s[strings.Index(s, "://")+3:]
	if !strings.Contains(rest, ":") && strings.HasPrefix(s, "http://") {
		s += ":4000"
	}
	return s
}

// isAdalKeep: the address answers as an Adal Keep server.
func isAdalKeep(u string) bool {
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Get(u + "/api/companion/info")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var info struct {
		Service string `json:"service"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&info)
	return resp.StatusCode == http.StatusOK && info.Service == "adal-keep"
}

// isMainWithNumber: the Adal Keep at u says the number is its own (it lets nothing in).
func isMainWithNumber(u, number string) bool {
	body, _ := json.Marshal(map[string]string{"number": number})
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Post(strings.TrimRight(u, "/")+"/api/pc-access/check-number", "application/json", bytes.NewReader(body))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var r struct {
		OK bool `json:"ok"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&r)
	return resp.StatusCode == http.StatusOK && r.OK
}

// cleanNumber: the digits of a typed PC number ("" unless 5 or 6 of them).
func cleanNumber(in string) string {
	var b strings.Builder
	for _, r := range in {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	if n := b.Len(); n < 5 || n > 6 {
		return ""
	}
	return b.String()
}

// mainByNumber: the main PC whose number this is — the saved address, an
// address typed with it (Tailscale, another branch), then the main PCs that
// answer on this network. "" when none says it is theirs.
func mainByNumber(root, number, typed string) string {
	var list []string
	seen := map[string]bool{}
	add := func(u string) {
		u = strings.TrimRight(u, "/")
		if u != "" && !seen[u] {
			seen[u] = true
			list = append(list, u)
		}
	}
	add(mainPCURL(root))
	add(normalizeMainURL(typed))
	for _, p := range foundPCs(2500 * time.Millisecond) {
		add(p["url"])
	}
	got := make(chan string, len(list))
	for _, u := range list {
		go func(u string) {
			if isMainWithNumber(u, number) {
				got <- u
			} else {
				got <- ""
			}
		}(u)
	}
	for range list {
		if u := <-got; u != "" {
			return u
		}
	}
	return ""
}

// joinByNumber: finds the main PC with this number, saves it and returns the
// address the window opens (it comes in there with the same number).
func joinByNumber(root, number, typed string) (string, string) {
	if number == "" {
		return "", "Type the main PC's number (5 digits, in its Settings → Main PC)."
	}
	u := mainByNumber(root, number, typed)
	if u == "" {
		return "", "No main PC with that number answers. Is it on, with Adal Keep open, and this PC on the same network? From another branch type its address too."
	}
	// Found by its number: the number is saved with it (its identity), and the
	// Companion may move the address when the router hands out new ones —
	// unless the address was typed here (another branch, Tailscale).
	// (The number is kept either way: the window comes back in with it by itself, hand.go.)
	save := func(root, u string) error { return saveTypedMainURLWith(root, u, number) }
	if strings.TrimRight(normalizeMainURL(typed), "/") != u {
		save = func(root, u string) error { return saveFoundMainURL(root, u, number) }
	}
	if err := save(root, u); err != nil {
		return "", "Could not save it: " + err.Error()
	}
	logf("main PC with the typed number: %s", u)
	chosenMainPC(root)
	hand := handFor(root, number)
	if hand == "" {
		hand = "adal_number=" + number
	}
	if !hasOnlinePages(root) {
		return u + "/#" + hand, ""
	}
	// A fresh pairing: the main PC gives this PC a new online account.
	return strings.TrimRight(u, "/") + "/?adal_companion=1&adal_repair=1#" + hand, ""
}

// saveFoundMainURL: written the way the Companion writes it (so it may
// update it), with the main PC's number.
func saveFoundMainURL(root, u, number string) error {
	body := "# Written by the Adal Keep Companion. Edit ADAL_HOST_URL or delete\r\n" +
		"# this file to let the Companion search the LAN again.\r\n" +
		"ADAL_HOST_URL=" + u + "\r\n"
	if number != "" {
		body += "ADAL_PC_NUMBER=" + number + "\r\n"
	}
	return os.WriteFile(filepath.Join(root, "companion.conf"), []byte(body), 0o644)
}

func saveTypedMainURL(root, u string) error { return saveTypedMainURLWith(root, u, "") }

func saveTypedMainURLWith(root, u, number string) error {
	body := "# Typed on this PC (Adal Keep could not find the main PC by itself).\r\n" +
		"# Delete this file to let the Companion search the network again.\r\n" +
		"ADAL_HOST_URL=" + u + "\r\n"
	if number != "" {
		body += "ADAL_PC_NUMBER=" + number + "\r\n"
	}
	return os.WriteFile(filepath.Join(root, "companion.conf"), []byte(body), 0o644)
}

// startConnectPage serves the page; false when the port is taken.
func startConnectPage(root string) bool {
	ln, err := net.Listen("tcp", connectAddr)
	if err != nil {
		return false
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, connectPage)
	})
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		u := mainPCURL(root)
		ok := u != "" && !signedOut(root) && isAdalKeep(u)
		if ok {
			u = companionURL(root, u)
		} else {
			u = ""
		}
		json.NewEncoder(w).Encode(map[string]any{"url": u, "signed_out": signedOut(root)})
	})
	mux.HandleFunc("/set", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		// Only this page (a header another website cannot send unasked).
		if r.Header.Get("X-Adal") != "1" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		res := map[string]any{}
		if u, msg := joinByNumber(root, cleanNumber(r.FormValue("number")), r.FormValue("address")); u != "" {
			res["url"] = u
		} else {
			res["error"] = msg
		}
		json.NewEncoder(w).Encode(res)
	})
	// The main PCs that answer on this network, to pick one (leave.go).
	mux.HandleFunc("/found", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"pcs": foundPCs(2500 * time.Millisecond)})
	})
	// Only this PC's own address: another website's name pointed here is refused.
	guard := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != connectAddr {
			http.Error(w, "Not this address", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
	go http.Serve(ln, guard)
	return true
}

const connectPage = `<!doctype html><html><head><meta charset="utf-8"><title>Adal Keep</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f8fafc;--card:#fff;--ink:#0f172a;--mute:#64748b;--line:#cbd5e1;--brand:#0d9488;--bad:#dc2626;--ok:#047857}
@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#1e293b;--ink:#f1f5f9;--mute:#94a3b8;--line:#475569;--bad:#f87171;--ok:#6ee7b7}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}
.c{background:var(--card);max-width:520px;margin:16px;padding:28px;border-radius:16px;box-shadow:0 4px 24px #0002}
h1{font-size:22px;margin:0 0 8px}p{color:var(--mute);margin:8px 0}
form{display:grid;gap:8px;margin-top:12px}input{min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:transparent;color:inherit}
#number{font:700 28px ui-monospace,monospace;letter-spacing:.4em;text-align:center}
button{padding:10px 16px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer}
#err{color:var(--bad)}#left{color:var(--ok)}details{color:var(--mute)}
</style></head><body><div class="c">
<p id="left" hidden></p>
<h1>Connect to the main Adal Keep PC</h1>
<p>Type the main PC's number. It is on the main PC in Adal Keep → Settings → Main PC (5 digits, e.g. 47040).</p>
<form id="f"><input id="number" name="number" inputmode="numeric" maxlength="6" placeholder="•••••" autofocus required>
<details><summary>Main PC in another branch?</summary><input name="address" placeholder="Its address, e.g. 100.101.102.103"></details>
<button>Connect</button></form>
<p id="err"></p>
</div><script>
const q=new URLSearchParams(location.search), err=document.getElementById('err');
if(q.has('left')){const l=document.getElementById('left');l.hidden=false;l.textContent='Logged out of the main PC'+(q.get('left')?' at '+q.get('left'):'')+'.'+(q.get('revoked')==='1'?' Its online account for this PC is stopped.':' Its online account for this PC is stopped as soon as that PC answers.')}
const n=document.getElementById('number');n.oninput=()=>{n.value=n.value.replace(/\D/g,'').slice(0,6)};
document.getElementById('f').onsubmit=async e=>{e.preventDefault();err.textContent='Looking for the main PC with that number…';
try{const r=await (await fetch('/set',{method:'POST',headers:{'X-Adal':'1'},body:new URLSearchParams(new FormData(e.target))})).json();
if(r.url){err.textContent='';location.href=r.url}else err.textContent=r.error}catch(x){err.textContent=String(x)}};
</script></body></html>`
