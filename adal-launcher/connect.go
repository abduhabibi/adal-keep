//go:build windows

// connect.go — the "Looking for the main PC" page on an employee PC.
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

func saveTypedMainURL(root, u string) error {
	body := "# Typed on this PC (Adal Keep could not find the main PC by itself).\r\n" +
		"# Delete this file to let the Companion search the network again.\r\n" +
		"ADAL_HOST_URL=" + u + "\r\n"
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
		u := normalizeMainURL(r.FormValue("address"))
		res := map[string]any{}
		switch {
		case u == "":
			res["error"] = "Type the main PC's address."
		case !isAdalKeep(u):
			res["error"] = "No Adal Keep answers at " + u + ". Check the address, that the main PC is on, and (from outside the office) that Tailscale is connected on both PCs."
		default:
			if err := saveTypedMainURL(root, u); err != nil {
				res["error"] = "Could not save it: " + err.Error()
			} else {
				logf("main PC address typed: %s", u)
				chosenMainPC(root)
				// A fresh pairing: the main PC gives this PC a new online account.
				res["url"] = companionURL(root, u) + "&adal_repair=1"
				if !hasOnlinePages(root) {
					res["url"] = u
				}
			}
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
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--brand);margin-right:8px;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.25}}
form{display:flex;gap:8px;margin-top:12px}input{flex:1;min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:transparent;color:inherit}
button{padding:10px 16px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer}
#err{color:var(--bad)}#left{color:var(--ok)}ol{color:var(--mute);padding-left:20px;margin:8px 0}
#pcs{list-style:none;padding:0;margin:8px 0}#pcs li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:6px}
#pcs small{color:var(--mute);display:block}
</style></head><body><div class="c">
<p id="left" hidden></p>
<h1 id="h"><span class="dot"></span>Looking for the main Adal Keep PC…</h1>
<p id="intro">Adal Keep opens by itself as soon as the main PC answers. Is the main PC turned on, with Adal Keep running?</p>
<div id="pick" hidden><p>Main PCs on this network:</p><ul id="pcs"></ul></div>
<ol><li>Is this PC on the same Wi-Fi or cable as the main PC?</li>
<li>Not in the list? On the <b>main PC</b> open Adal Keep → Settings → Main PC. Under “Addresses of this main PC” it shows an address like <b>192.168.1.20:4000</b> (in the office) or <b>100.x.x.x:4000</b> (Tailscale). Type it here:</li></ol>
<form id="f"><input name="address" placeholder="e.g. 192.168.1.20 or 100.101.102.103" autofocus><button>Connect</button></form>
<p id="err"></p>
</div><script>
const go=u=>{location.href=u};
const q=new URLSearchParams(location.search), err=document.getElementById('err');
if(q.has('left')){const l=document.getElementById('left');l.hidden=false;l.textContent='Logged out of the main PC'+(q.get('left')?' at '+q.get('left'):'')+'.'+(q.get('revoked')==='1'?' Its online account for this PC is stopped.':' Its online account for this PC is stopped as soon as that PC answers.')}
let out=false;
async function poll(){try{const r=await (await fetch('/status')).json();if(r.url)return go(r.url);if(r.signed_out&&!out){out=true;document.getElementById('h').textContent='Connect to a main Adal Keep PC';document.getElementById('intro').textContent='Pick the main PC this PC works with, or type its address.'}}catch(e){}setTimeout(poll,3000)}
poll();
async function connect(address){err.textContent='Checking…';
try{const r=await (await fetch('/set',{method:'POST',headers:{'X-Adal':'1'},body:new URLSearchParams({address})})).json();
if(r.url){err.textContent='';go(r.url)}else err.textContent=r.error}catch(x){err.textContent=String(x)}}
document.getElementById('f').onsubmit=e=>{e.preventDefault();connect(new FormData(e.target).get('address'))};
async function found(){try{const r=await (await fetch('/found')).json();const ul=document.getElementById('pcs');ul.textContent='';
for(const p of r.pcs||[]){const li=document.createElement('li'),t=document.createElement('span'),b=document.createElement('button');
t.textContent=p.name;const s=document.createElement('small');s.textContent=p.url.replace('http://','');t.appendChild(s);
b.textContent='Connect';b.onclick=()=>connect(p.url);li.append(t,b);ul.appendChild(li)}
document.getElementById('pick').hidden=!(r.pcs||[]).length}catch(e){}setTimeout(found,15000)}
found();
</script></body></html>`
