#!/usr/bin/env python3
"""
local_agent.py — local-LLM shell agent with a browser UI.
Talks to Ollama / llama.cpp / LM Studio over their OpenAI-compatible HTTP APIs.
No Playwright, no DeepSeek, no browser automation.

Run:  python3 local_agent.py
Open: http://localhost:8765
"""

import os
import re
import sys
import json
import time
import sqlite3
import subprocess
import threading
import queue
import webbrowser
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import URLError

# ============================================================
# CONFIG
# ============================================================
PORT              = 8765
WORKDIR           = "~"

AGENT_DIR         = "~/.agent"
CONTEXT_DIR       = "~/.agent/context"
BIN_DIR           = "~/.agent/bin"
GENERAL_DB        = "general.db"
INDEX_DB          = "_index.db"

# Backends tried in order. First one that answers /v1/models wins.
# Model name must match what `ollama list` shows.
BACKENDS = [
    ("ollama",    "http://localhost:11434/v1", "llama3:latest"),
    ("llama.cpp", "http://localhost:8080/v1",  "local-model"),
    ("lmstudio",  "http://localhost:1234/v1",  "local-model"),
]

CMD_TIMEOUT       = 60
MAX_STEPS         = 25
OUTPUT_LIMIT      = 1800
UI_OUTPUT_LIMIT   = 6000
REQUEST_TIMEOUT   = 120

# ============================================================
# SQL schemas
# ============================================================
FACTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_topic ON facts(topic);
"""

DOMAINS_SCHEMA = """
CREATE TABLE IF NOT EXISTS domains (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""

DEFAULT_DOMAINS = [
    ("general",      "identity, preferences, background"),
    ("finance",      "income, expenses, accounts, goals"),
    ("startup",      "the startup: metrics, decisions, team, roadmap"),
    ("investment",   "portfolio, positions, thesis, watchlist"),
    ("intelligence", "people, orgs, research notes"),
    ("chess",        "games, openings, analysis, ratings"),
    ("hacking",      "CTFs, tools, vulnerabilities, notes"),
]

# ============================================================
# Helper shell scripts (written to ~/.agent/bin/)
# ============================================================
HELPER_REMEMBER = r'''#!/usr/bin/env bash
set -e
domain="$1"; topic="$2"; content="$3"; tags="${4:-}"
db="$HOME/.agent/context/$domain.db"
[ -f "$db" ] || { echo "no such domain: $domain" >&2; exit 1; }
esc() { printf "%s" "$1" | sed "s/'/''/g"; }
sqlite3 "$db" "INSERT INTO facts(topic,content,tags) VALUES('$(esc "$topic")','$(esc "$content")','$(esc "$tags")')"
echo "saved to $domain"
'''

HELPER_RECALL = r'''#!/usr/bin/env bash
set -e
domain="$1"; search="$2"
db="$HOME/.agent/context/$domain.db"
[ -f "$db" ] || { echo "no such domain: $domain" >&2; exit 1; }
esc() { printf "%s" "$1" | sed "s/'/''/g"; }
sqlite3 -line "$db" "SELECT topic, content, tags, updated_at FROM facts
  WHERE topic   LIKE '%$(esc "$search")%'
     OR content LIKE '%$(esc "$search")%'
     OR tags    LIKE '%$(esc "$search")%'
  ORDER BY updated_at DESC LIMIT 50"
'''

HELPER_NEWDOMAIN = r'''#!/usr/bin/env bash
set -e
name="$1"; desc="$2"
db="$HOME/.agent/context/$name.db"
[ -f "$db" ] && { echo "already exists: $name" >&2; exit 1; }
sqlite3 "$db" "CREATE TABLE facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX idx_topic ON facts(topic);"
esc() { printf "%s" "$1" | sed "s/'/''/g"; }
sqlite3 "$HOME/.agent/context/_index.db" \
  "INSERT INTO domains(name,description) VALUES('$(esc "$name")','$(esc "$desc")')"
echo "created domain: $name"
'''

# ============================================================
# Event broker (Server-Sent Events)
# ============================================================
SUBSCRIBERS = []
SUB_LOCK = threading.Lock()


def emit(kind, text=""):
    ev = {"kind": kind, "text": text, "ts": time.time()}
    with SUB_LOCK:
        dead = []
        for q in SUBSCRIBERS:
            try:
                q.put_nowait(ev)
            except queue.Full:
                dead.append(q)
        for q in dead:
            SUBSCRIBERS.remove(q)


# ============================================================
# Memory / bootstrap
# ============================================================
def init_agent_dirs():
    for d in (AGENT_DIR, CONTEXT_DIR, BIN_DIR):
        Path(os.path.expanduser(d)).mkdir(parents=True, exist_ok=True)

    idx = Path(os.path.expanduser(CONTEXT_DIR)) / INDEX_DB
    conn = sqlite3.connect(idx)
    conn.executescript(DOMAINS_SCHEMA)
    for name, desc in DEFAULT_DOMAINS:
        conn.execute(
            "INSERT OR IGNORE INTO domains(name,description) VALUES(?,?)",
            (name, desc),
        )
    conn.commit()
    conn.close()

    for name, _ in DEFAULT_DOMAINS:
        db = Path(os.path.expanduser(CONTEXT_DIR)) / (name + ".db")
        conn = sqlite3.connect(db)
        conn.executescript(FACTS_SCHEMA)
        conn.commit()
        conn.close()

    helpers = {
        "remember.sh": HELPER_REMEMBER,
        "recall.sh": HELPER_RECALL,
        "newdomain.sh": HELPER_NEWDOMAIN,
    }
    for name, body in helpers.items():
        p = Path(os.path.expanduser(BIN_DIR)) / name
        p.write_text(body)
        p.chmod(0o755)


def dump_general(limit=12000):
    db = Path(os.path.expanduser(CONTEXT_DIR)) / GENERAL_DB
    if not db.exists():
        return "(no general.db yet)"
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute(
            "SELECT topic, content FROM facts ORDER BY updated_at DESC"
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return "(no entries yet)"
    text = "\n".join("- " + t + ": " + c for t, c in rows)
    if len(text) > limit:
        text = text[:limit] + "\n...[truncated]"
    return text


def dump_domains():
    idx = Path(os.path.expanduser(CONTEXT_DIR)) / INDEX_DB
    conn = sqlite3.connect(idx)
    try:
        rows = conn.execute(
            "SELECT name, description FROM domains ORDER BY name"
        ).fetchall()
    finally:
        conn.close()
    return "\n".join("- " + n + ".db -- " + d for n, d in rows)


def system_prompt():
    template = """You are a shell agent on Linux, running as user {user}.
You solve the user's task by running bash commands.

OUTPUT FORMAT - obey exactly:
- Your entire reply MUST be one fenced bash code block.
- Nothing before the opening fence and nothing after the closing fence.
- No explanation, no greeting, no prose.

CONTROL:
- To finish: the LAST line inside the block must be exactly:  echo DONE
- To ask the user: the LAST line of output must be:  echo ASK: <question>
  Never put the string "ASK:" anywhere else.

WHAT THE USER SEES:
- The user does NOT see stdout of your commands.
- To answer the user, print with `echo "..."`, then a final `echo DONE`.
- Intermediate commands (ls, cat, grep) are for your reasoning only.

TOKEN DISCIPLINE:
- Discover cheap: ls, du -sh */, find . -maxdepth 2 -type f | head -40
- NEVER read: node_modules/ .git/ dist/ build/ .venv/ uploads/
  Never read: zip, exe, bin, db, jpg, png, pdf, lock files
  Never read: all-source.txt AdalTree.txt
- Before cat: run wc -l on the file. If over 150 lines, use head -80 or grep.
- Max 3 exploration commands before answering.

MEMORY (use when relevant):
- recall: {bindir}/recall.sh <domain> <search>
- save:   {bindir}/remember.sh <domain> <topic> <content> <tags>
- new:    {bindir}/newdomain.sh <name> <description>

Domains:
{domains}

RULES:
- Never use sudo. Never touch /etc /usr /boot.
- Destructive commands (rm, mv, >, truncate): first run  echo ASK: confirm <paths>
- Working directory: {workdir}

GENERAL CONTEXT:
{general}
END GENERAL CONTEXT.
"""
    return template.format(
        user=os.getenv("USER", "user"),
        bindir=os.path.expanduser(BIN_DIR),
        domains=dump_domains(),
        workdir=os.path.expanduser(WORKDIR),
        general=dump_general(),
    )


# ============================================================
# Backend detection + call
# ============================================================
ACTIVE_BACKEND = None


def detect_backend():
    global ACTIVE_BACKEND
    ACTIVE_BACKEND = None
    for name, base, default_model in BACKENDS:
        try:
            req = Request(base + "/models", method="GET")
            with urlopen(req, timeout=3) as r:
                data = json.loads(r.read().decode())
            models = [m.get("id") for m in data.get("data", [])]
            if not models:
                continue
            pick = default_model if default_model in models else models[0]
            ACTIVE_BACKEND = {"name": name, "base": base, "model": pick}
            return
        except (URLError, OSError, ValueError):
            continue


def call_model(messages):
    if not ACTIVE_BACKEND:
        raise RuntimeError("no local backend available")
    body = json.dumps({
        "model": ACTIVE_BACKEND["model"],
        "messages": messages,
        "temperature": 0.1,
        "stream": False,
    }).encode()
    req = Request(
        ACTIVE_BACKEND["base"] + "/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=REQUEST_TIMEOUT) as r:
            data = json.loads(r.read().decode())
        return data["choices"][0]["message"]["content"]
    except (URLError, OSError, KeyError, ValueError) as e:
        raise RuntimeError("backend error: " + str(e))


# ============================================================
# Reply parsing
# ============================================================
CODE_RE  = re.compile(r"```(?:bash|sh)?\s*\n(.*?)```", re.DOTALL)
LOOSE_RE = re.compile(r"```\s*\n?(.*?)\n?```", re.DOTALL)
CMD_HINT = re.compile(
    r"\s*(ls|cat|echo|grep|find|git|cd|du|wc|pwd|whoami|head|tail|sed|awk|mkdir|cp|mv|rm)\b"
)


def extract_code(reply):
    if not reply:
        return None
    m = CODE_RE.search(reply)
    if m:
        return m.group(1).strip()
    m = LOOSE_RE.search(reply)
    if m:
        return m.group(1).strip()
    lines = reply.strip().split("\n")
    hits = sum(1 for l in lines if CMD_HINT.match(l))
    if hits >= 1:
        return reply.strip()
    return None


# ============================================================
# Exec
# ============================================================
def truncate(s, n):
    if not s:
        return s
    return s if len(s) <= n else s[:n] + "\n...[+" + str(len(s) - n) + " chars]"


def run_code(code, cwd):
    try:
        r = subprocess.run(
            ["bash", "-c", code],
            capture_output=True,
            text=True,
            timeout=CMD_TIMEOUT,
            cwd=str(cwd),
        )
        return r.stdout, r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        return "", "[timeout " + str(CMD_TIMEOUT) + "s]", 124


# ============================================================
# Agent loop
# ============================================================
INBOX = queue.Queue()
STATE = {"mode": "idle"}


def run_task(task, cwd):
    emit("user", task)
    messages = [
        {"role": "system", "content": system_prompt()},
        {"role": "user",   "content": task},
    ]

    for step in range(1, MAX_STEPS + 1):
        emit("status", "step " + str(step) + " -- thinking...")
        t0 = time.time()
        try:
            reply = call_model(messages)
        except Exception as e:
            emit("error", "model call failed: " + str(e))
            return
        dt = time.time() - t0
        emit("status", "step " + str(step) + " -- replied in " + ("%.2f" % dt) + "s")

        code = extract_code(reply)
        if not code:
            emit("output", "[unparseable reply]\n" + reply[:500])
            messages.append({"role": "assistant", "content": reply})
            messages.append({
                "role": "user",
                "content": "Your reply had no bash code block. Reply again with ONLY a fenced bash block. Nothing else.",
            })
            continue

        emit("command", code)
        out, err, rc = run_code(code, cwd)
        combined = (out + ("\n" + err if err.strip() else "")).strip()
        if combined:
            emit("output", truncate(combined, UI_OUTPUT_LIMIT))

        lines = [l for l in out.split("\n") if l.strip()]
        last = lines[-1].strip() if lines else ""

        if last == "DONE":
            body = "\n".join(lines[:-1]).strip()
            if body:
                emit("agent", body)
            return

        if last.startswith("ASK:"):
            emit("question", last[4:].strip())
            STATE["mode"] = "asking"
            try:
                user_reply = INBOX.get(timeout=3600)
            except queue.Empty:
                user_reply = "(no answer)"
            STATE["mode"] = "busy"
            messages.append({"role": "assistant", "content": code})
            messages.append({
                "role": "user",
                "content": "User answered: " + user_reply + "\nContinue the task.",
            })
            continue

        messages.append({"role": "assistant", "content": code})
        messages.append({
            "role": "user",
            "content": "exit=" + str(rc)
                       + "\nstdout:\n" + truncate(out, OUTPUT_LIMIT)
                       + "\nstderr:\n" + truncate(err, 600),
        })

    emit("error", "hit MAX_STEPS (" + str(MAX_STEPS) + ") without finishing")


def agent_thread():
    cwd = Path(os.path.expanduser(WORKDIR))
    emit("status", "detecting local backend...")
    detect_backend()
    if not ACTIVE_BACKEND:
        emit("error", "no local model found. Start ollama / llama-server / LM Studio, then refresh the page.")
        return
    emit("status", "using " + ACTIVE_BACKEND["name"] + " -- model: " + ACTIVE_BACKEND["model"])
    STATE["mode"] = "idle"
    emit("status", "ready")

    while True:
        task = INBOX.get()
        if task is None:
            break
        STATE["mode"] = "busy"
        try:
            run_task(task, cwd)
        except Exception as e:
            emit("error", "task error: " + str(e))
        STATE["mode"] = "idle"
        emit("status", "ready")


# ============================================================
# UI
# ============================================================
HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#c9d1d9;--muted:#8b949e;
        --accent:#58a6ff;--user:#1f6feb;--cmd:#7ee787;--out:#8b949e;--err:#f85149;--ask:#d29922}
  *{box-sizing:border-box}html,body{height:100%;margin:0}
  body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       display:flex;flex-direction:column}
  header{padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;background:var(--panel)}
  header .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);transition:background .2s}
  header .dot.busy{background:var(--ask);animation:pulse 1.4s infinite}
  header .dot.idle{background:var(--cmd)}header .dot.asking{background:var(--ask)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  header h1{font-size:14px;font-weight:600;margin:0;flex:1}
  header .model{opacity:.5;font-weight:400;font-size:12px}
  header .btn{background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;
              padding:4px 10px;cursor:pointer;font-size:12px}
  header .btn:hover{color:var(--text);border-color:var(--muted)}
  main{flex:1;overflow-y:auto;padding:20px 0}
  .row{padding:6px 20px;display:flex}.row.user{justify-content:flex-end}
  .bubble{max-width:min(760px,80%);padding:10px 14px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word}
  .user .bubble{background:var(--user);color:white}
  .agent .bubble{background:var(--panel);border:1px solid var(--border)}
  .question .bubble{background:rgba(210,153,34,.1);border:1px solid var(--ask);color:var(--ask)}
  .question .bubble::before{content:"agent asks ";font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.5px}
  .status{padding:4px 20px;color:var(--muted);font-size:12px;font-style:italic}
  .status.ready{color:var(--cmd)}.status.error{color:var(--err);font-style:normal}
  body:not(.verbose) .cmd, body:not(.verbose) .output{display:none}
  .cmd{margin:6px 20px;background:#010409;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .cmd>.hdr,.output>.hdr{padding:4px 10px;font-size:11px;color:var(--muted);background:var(--panel);
    border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
  .cmd>pre{margin:0;padding:10px 12px;font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--cmd);white-space:pre-wrap;word-wrap:break-word}
  .output{margin:0 20px 6px;background:#0d1117;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .output>pre{margin:0;padding:10px 12px;font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--out);white-space:pre-wrap;word-wrap:break-word;max-height:400px;overflow-y:auto}
  .cmd.collapsed>pre,.output.collapsed>pre{display:none}
  footer{border-top:1px solid var(--border);background:var(--panel);padding:12px 20px;display:flex;gap:10px}
  footer textarea{flex:1;resize:none;height:44px;padding:10px 12px;background:var(--bg);color:var(--text);
    border:1px solid var(--border);border-radius:8px;font:14px/1.4 inherit;outline:none}
  footer textarea:focus{border-color:var(--accent)}
  footer button{padding:0 22px;border:0;border-radius:8px;background:var(--accent);color:white;font-weight:600;cursor:pointer}
</style></head>
<body>
<header>
  <div class="dot idle" id="dot"></div>
  <h1>Adal Agent <span class="model" id="model"></span></h1>
  <button class="btn" id="verbose">Verbose</button>
  <button class="btn" id="newtask">New task</button>
</header>
<main id="chat"></main>
<footer>
  <textarea id="input" placeholder="Type a task…"></textarea>
  <button id="send">Send</button>
</footer>
<script>
const chat=document.getElementById('chat'),input=document.getElementById('input'),
      send=document.getElementById('send'),dot=document.getElementById('dot'),
      model=document.getElementById('model');
function scroll(){chat.scrollTop=chat.scrollHeight}
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function addRow(kind,text){
  if(kind==='command'){
    const b=el('div','cmd');const h=el('div','hdr','command');
    h.onclick=()=>b.classList.toggle('collapsed');
    b.append(h,el('pre',null,text));chat.append(b);
  } else if(kind==='output'){
    const b=el('div','output');const h=el('div','hdr','output');
    h.onclick=()=>b.classList.toggle('collapsed');
    b.append(h,el('pre',null,text));chat.append(b);
  } else if(kind==='status'){
    const s=el('div','status',text);
    if(text==='ready')s.classList.add('ready');
    if(text.indexOf('using ')==0)model.textContent='— '+text.slice(6);
    chat.append(s);
  } else if(kind==='error'){
    chat.append(el('div','status error',text));
  } else {
    const r=el('div','row '+kind);r.append(el('div','bubble',text));chat.append(r);
  }
  scroll();
}
const es=new EventSource('/events');
es.onmessage=e=>{
  const ev=JSON.parse(e.data);
  if(ev.kind==='status')dot.className=ev.text==='ready'?'dot idle':'dot busy';
  if(ev.kind==='question')dot.className='dot asking';
  if(ev.kind==='user')dot.className='dot busy';
  addRow(ev.kind,ev.text);
};
async function submit(){
  const t=input.value.trim();if(!t)return;input.value='';
  await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})});
}
send.onclick=submit;
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit();}});
const vbtn=document.getElementById('verbose');
vbtn.onclick=()=>{
  document.body.classList.toggle('verbose');
  vbtn.style.color=document.body.classList.contains('verbose')?'var(--accent)':'var(--muted)';
  scroll();
};
document.getElementById('newtask').onclick=()=>addRow('status','── new task ──');
input.focus();
</script>
</body></html>"""


# ============================================================
# HTTP server
# ============================================================
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            body = HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            q = queue.Queue(maxsize=1000)
            with SUB_LOCK:
                SUBSCRIBERS.append(q)
            try:
                hello = json.dumps({"kind": "status", "text": "connected"})
                self.wfile.write(("data: " + hello + "\n\n").encode())
                self.wfile.flush()
                while True:
                    try:
                        ev = q.get(timeout=20)
                        self.wfile.write(("data: " + json.dumps(ev) + "\n\n").encode())
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with SUB_LOCK:
                    if q in SUBSCRIBERS:
                        SUBSCRIBERS.remove(q)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode() or "{}")
        except Exception:
            data = {}

        if self.path == "/send":
            t = (data.get("text") or "").strip()
            if t:
                INBOX.put(t)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        self.send_response(404)
        self.end_headers()


# ============================================================
# Entry
# ============================================================
def main():
    init_agent_dirs()
    threading.Thread(target=agent_thread, daemon=True).start()

    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = "http://localhost:" + str(PORT)
    print("[local_agent] UI: " + url)

    def open_browser():
        time.sleep(0.6)
        try:
            webbrowser.get("firefox").open(url)
        except Exception:
            try:
                webbrowser.open(url)
            except Exception:
                pass

    threading.Thread(target=open_browser, daemon=True).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[local_agent] bye")
        INBOX.put(None)


if __name__ == "__main__":
    main()