#!/usr/bin/env python3
"""
webui.py — browser-based GUI for the DeepSeek agent.

Run:  python3 webui.py  (or ./start-agent.sh)
Open: http://localhost:8765
"""

import os, re, sys, time, json, random, sqlite3, subprocess
import threading, queue, webbrowser
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

# ============================================================
# CONFIG
# ============================================================
PORT             = 8765
PROFILE_DIR      = "~/.deepseek_agent_profile_fx"
START_URL        = "https://chat.deepseek.com"
CHAT_URL_FILE    = "~/.agent/last_deepseek_chat.txt"

WORKDIR          = "~"
AGENT_DIR        = "~/.agent"
CONTEXT_DIR      = "~/.agent/context"
BIN_DIR          = "~/.agent/bin"
GENERAL_DB       = "general.db"
INDEX_DB         = "_index.db"

CMD_TIMEOUT      = 60
RESPONSE_TIMEOUT = 300
STABLE_SECONDS   = 0.9          # how long reply must be unchanged
STREAM_CONFIRM   = 0.4          # second-check delay after stable
MAX_STEPS        = 60
OUTPUT_LIMIT     = 1800         # chars per step fed back to model
UI_OUTPUT_LIMIT  = 6000         # chars shown in verbose UI
TOKEN_BUDGET_WARN = 120_000     # chars sent to model across a task

INPUT_SELECTORS  = ["textarea", "div[contenteditable='true']", "[role='textbox']"]
CODE_SELECTORS   = ["pre code", "pre"]

# selectors for the "stop generating" button — used to detect streaming
STOP_BUTTON_SELECTORS = [
    "button[aria-label*='Stop' i]",
    "button[aria-label*='stop' i]",
    "[data-testid*='stop' i]",
    "div[role='button'][aria-label*='top' i]",
    "svg[class*='stop' i]",
]

LOCALE     = "en-US"
TIMEZONE   = "Africa/Addis_Ababa"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"
VIEWPORT   = {"width": 1440, "height": 900}

FIREFOX_PREFS = {
    "dom.webdriver.enabled": False,
    "useAutomationExtension": False,
    "remote.enabled": False,
    "remote.active-protocols": 0,
    "marionette.enabled": False,
    "dom.webnotifications.enabled": False,
    "media.navigator.enabled": False,
    "media.peerconnection.enabled": False,
    "media.webspeech.recognition.enable": False,
    "media.webspeech.synth.enabled": False,
    "device.sensors.enabled": False,
    "dom.battery.enabled": False,
    "dom.gamepad.enabled": False,
    "geo.enabled": False,
    "network.http.referer.XOriginTrimmingPolicy": 2,
    "network.http.referer.XOriginPolicy": 2,
    "beacon.enabled": False,
    "browser.send_pings": False,
    "toolkit.telemetry.enabled": False,
    "datareporting.healthreport.uploadEnabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "app.shield.optoutstudies.enabled": False,
    "privacy.resistFingerprinting": False,
    "privacy.trackingprotection.enabled": True,
    "browser.startup.page": 3,
    "browser.startup.homepage": "about:blank",
    "browser.tabs.warnOnClose": False,
    "browser.warnOnQuit": False,
    "dom.disable_beforeunload": True,
    "pdfjs.disabled": True,
    "webgl.disabled": False,
}

FIREFOX_ARGS = [
    "--no-remote",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--no-first-run",
    "--no-default-browser-check",
]

# ============================================================
# Schemas
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
    ("general",      "identity, preferences, background — ALWAYS LOADED"),
    ("finance",      "income, expenses, accounts, financial goals"),
    ("startup",      "the user's startup: metrics, decisions, team, roadmap"),
    ("investment",   "portfolio, positions, thesis, watchlist"),
    ("intelligence", "people, orgs, research notes"),
    ("chess",        "games, openings, analysis, ratings"),
    ("hacking",      "CTFs, tools, vulnerabilities, notes"),
]

HELPER_REMEMBER = r"""#!/usr/bin/env bash
set -e
domain="$1"; topic="$2"; content="$3"; tags="${4:-}"
db="$HOME/.agent/context/$domain.db"
[ -f "$db" ] || { echo "no such domain: $domain" >&2; exit 1; }
esc() { printf "%s" "$1" | sed "s/'/''/g"; }
sqlite3 "$db" "INSERT INTO facts(topic,content,tags) VALUES('$(esc "$topic")','$(esc "$content")','$(esc "$tags")')"
echo "saved to $domain"
"""

HELPER_RECALL = r"""#!/usr/bin/env bash
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
"""

HELPER_NEWDOMAIN = r"""#!/usr/bin/env bash
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
"""

# ============================================================
# Event broker
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
# Memory
# ============================================================
def init_agent_dirs():
    for d in (AGENT_DIR, CONTEXT_DIR, BIN_DIR):
        Path(os.path.expanduser(d)).mkdir(parents=True, exist_ok=True)

    idx = Path(os.path.expanduser(CONTEXT_DIR)) / INDEX_DB
    conn = sqlite3.connect(idx)
    conn.executescript(DOMAINS_SCHEMA)
    for name, desc in DEFAULT_DOMAINS:
        conn.execute("INSERT OR IGNORE INTO domains(name,description) VALUES(?,?)",
                     (name, desc))
    conn.commit(); conn.close()

    for name, _ in DEFAULT_DOMAINS:
        db = Path(os.path.expanduser(CONTEXT_DIR)) / f"{name}.db"
        conn = sqlite3.connect(db); conn.executescript(FACTS_SCHEMA)
        conn.commit(); conn.close()

    for name, body in {"remember.sh": HELPER_REMEMBER,
                       "recall.sh": HELPER_RECALL,
                       "newdomain.sh": HELPER_NEWDOMAIN}.items():
        p = Path(os.path.expanduser(BIN_DIR)) / name
        p.write_text(body); p.chmod(0o755)

def dump_general(limit=20_000):
    
    db = Path(os.path.expanduser(CONTEXT_DIR)) / GENERAL_DB
    if not db.exists():
        return "(no general.db yet)"
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute("SELECT topic, content FROM facts ORDER BY updated_at DESC").fetchall()
    finally:
        conn.close()
    if not rows:
        return "(no entries yet)"
    text = "\n".join(f"- {t}: {c}" for t, c in rows)
    return text[:limit] + "\n...[truncated]" if len(text) > limit else text

def dump_domains():
    idx = Path(os.path.expanduser(CONTEXT_DIR)) / INDEX_DB
    conn = sqlite3.connect(idx)
    try:
        rows = conn.execute("SELECT name, description FROM domains ORDER BY name").fetchall()
    finally:
        conn.close()
    return "\n".join(f"- {n}.db — {d}" for n, d in rows)

def build_system_prompt():
    template = """You are not chatting with a human. You are the reasoning brain of an automation loop.

HOW THE LOOP WORKS — read this carefully, it changes how you reply:
1. You reply with one bash code block.
2. A Python script immediately extracts it and runs it with `bash` on the user's Linux machine.
3. The script captures stdout, stderr, and exit code, then sends them back to you as the next user message.
4. You see that output and reply with the next bash block.
5. This repeats automatically, at machine speed. No human is typing between steps.

CRITICAL CONSEQUENCES:
- NEVER ask permission. NEVER say "shall I proceed" or "would you like me to". There is no human to answer — only the script, which can only send you command output.
- NEVER explain what you are about to do in prose. Just do it in the next block.
- NEVER stop mid-task waiting for confirmation. Keep emitting bash blocks until the task is complete.
- Intermediate output (ls, cat, grep, find, git) is YOUR private scratchpad. The user does not see it. Only what you print with `echo` reaches the user, and only at the very end.

HOW TO SPEAK TO THE USER:
- To answer:  echo "your answer"  (one or more echo lines), then a final line:  echo DONE
- To ask the user something:  the LAST line of output must be exactly:  echo ASK: <your question>
  Then the script pauses, shows the question to the user, and feeds their typed reply back to you.
  Never put the string "ASK:" anywhere else in your output.

RULES OF THE MACHINE:
- You are running as user `{user}`.
- Working directory: {workdir}
- Full read/write access to the filesystem.
- Never use sudo. Never touch /etc /usr /boot.
- Destructive commands (rm, mv, >, truncate) must be preceded by:  echo ASK: confirm <paths>
- If a command fails, read the error and try a different approach in your next block. Do not give up.

TOKEN DISCIPLINE (every character costs):
- Discover cheap first:  ls  /  du -sh */  /  find . -maxdepth 2 -type f | head -40
- Never read: node_modules/ .git/ dist/ build/ .venv/ uploads/
- Never read: zip, exe, bin, db, jpg, png, pdf, lock files
- Never read: all-source.txt, AdalTree.txt (they are huge)
- Before cat:  wc -l <file>
    <=150 lines  -> ok
    >150 lines   -> head -80 or grep -n "pattern" <file>
- Max 3 exploration commands before you either answer or ask. Do not wander.

MEMORY:
- recall a fact:  {bindir}/recall.sh <domain> <search>
- save a fact:    {bindir}/remember.sh <domain> "<topic>" "<content>" "<tags>"
- new domain:     {bindir}/newdomain.sh <name> "<description>"
Available domains:
{domains}
Save durable facts about the user after meaningful tasks. One fact per row. Plain English. Short.

REMEMBER: you are not done until the user's task is answered. Emit bash blocks until you can print the answer with `echo`, then finish with `echo DONE`.

=== GENERAL CONTEXT (already loaded) ===
{general}
=== END ===
"""
    return template.format(
        user=os.getenv("USER", "user"),
        workdir=os.path.expanduser(WORKDIR),
        bindir=os.path.expanduser(BIN_DIR),
        domains=dump_domains(),
        general=dump_general(),
    )
# ============================================================
# Browser plumbing
# ============================================================
def find_input(page):
    for sel in INPUT_SELECTORS:
        try:
            el = page.query_selector(sel)
            if el: return el
        except Exception: pass
    return None

def last_code_block(page):
    for sel in CODE_SELECTORS:
        try: els = page.query_selector_all(sel)
        except Exception: els = []
        if els:
            try: return els[-1].inner_text()
            except Exception: continue
    return None

def is_streaming(page):
    """True if the model is currently generating (stop button visible)."""
    for sel in STOP_BUTTON_SELECTORS:
        try:
            if page.query_selector(sel):
                return True
        except Exception:
            pass
    return False

def human_pause(lo=20, hi=60):
    time.sleep(random.uniform(lo, hi) / 1000.0)

def send_message(page, text):
    box = find_input(page)
    if not box: raise RuntimeError("chat input not found")
    box.click()
    human_pause()
    page.keyboard.insert_text(text)
    human_pause(60, 120)
    page.keyboard.press("Enter")

def wait_for_reply(page, prev, timeout=RESPONSE_TIMEOUT):
    """
    Robust wait:
      1. If stop-button selector works, wait for it to disappear.
      2. Otherwise, wait for the code block to be stable for STABLE_SECONDS,
         then double-check after STREAM_CONFIRM.
    """
    start = time.time()

    # --- path 1: streaming detector ---
    saw_stream = False
    while time.time() - start < 2:
        if is_streaming(page):
            saw_stream = True
            break
        time.sleep(0.3)

    if saw_stream:
        while time.time() - start < timeout:
            if not is_streaming(page):
                time.sleep(1.0)
                if not is_streaming(page):
                    return last_code_block(page)
            time.sleep(0.12)
        return last_code_block(page)

    # --- path 2: stability fallback ---
    last, since = None, None
    while time.time() - start < timeout:
        txt = last_code_block(page)
        if txt and txt != prev:
            if txt != last:
                last, since = txt, time.time()
            elif since and (time.time() - since) >= STABLE_SECONDS:
                time.sleep(STREAM_CONFIRM)
                txt2 = last_code_block(page)
                if txt2 == txt:
                    return txt
                last, since = txt2, time.time()
        time.sleep(0.4)
    return last

def truncate(s, n):
    if not s: return s
    return s if len(s) <= n else s[:n] + f"\n...[truncated {len(s)-n} chars]"

def run_code(code, cwd):
    try:
        r = subprocess.run(["bash", "-c", code], capture_output=True, text=True,
                           timeout=CMD_TIMEOUT, cwd=str(cwd))
        return r.stdout, r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        return "", f"[timeout after {CMD_TIMEOUT}s]", 124

def load_chat_url():
    try:
        u = Path(os.path.expanduser(CHAT_URL_FILE)).read_text().strip()
        return u or None
    except FileNotFoundError:
        return None

def save_chat_url(page):
    url = page.url
    if not url or "chat.deepseek.com" not in url: return
    if url.rstrip("/") == START_URL.rstrip("/"): return
    p = Path(os.path.expanduser(CHAT_URL_FILE))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(url)

# ============================================================
# Agent worker
# ============================================================
INBOX = queue.Queue()
STATE = {"mode": "idle"}

def run_task(page, task, cwd):
    emit("user", task)
    prev = last_code_block(page)
    send_message(page, task)

    token_used = 0

    for step in range(1, MAX_STEPS + 1):
        emit("status", f"waiting for model (step {step})...")
        code = wait_for_reply(page, prev)
        if not code:
            emit("error", "no reply from model — stopping this task")
            return
        code = code.strip(); prev = code
        emit("command", code)

        out, err, rc = run_code(code, cwd)
        combined = (out + ("\n" + err if err.strip() else "")).strip()
        if combined:
            emit("output", truncate(combined, UI_OUTPUT_LIMIT))

        # decide what to send back to the model
        lines = [l for l in out.split("\n") if l.strip()]
        last = lines[-1].strip() if lines else ""

        if last == "DONE":
            body = "\n".join(lines[:-1]).strip()
            if body:
                emit("agent", body)
            save_chat_url(page)
            if token_used > TOKEN_BUDGET_WARN:
                emit("status", f"token note: {token_used} chars sent this task")
            return

        if last.startswith("ASK:"):
            q = last[4:].strip()
            emit("question", q)
            STATE["mode"] = "asking"
            try:
                reply = INBOX.get(timeout=3600)
            except queue.Empty:
                reply = "(no answer)"
            STATE["mode"] = "busy"
            prev = last_code_block(page)
            send_message(page, reply)
            continue

        # feed output back — capped hard
        payload = f"exit={rc}\nstdout:\n{truncate(out, OUTPUT_LIMIT)}\nstderr:\n{truncate(err, 800)}"
        token_used += len(payload)
        prev = last_code_block(page)
        send_message(page, payload)


def agent_thread():
    STATE["mode"] = "busy"
    cwd = Path(os.path.expanduser(WORKDIR))

    with sync_playwright() as p:
        emit("status", "launching firefox...")
        ctx = p.firefox.launch_persistent_context(
            user_data_dir=os.path.expanduser(PROFILE_DIR),
            headless=False,
            firefox_user_prefs=FIREFOX_PREFS,
            args=FIREFOX_ARGS,
            locale=LOCALE,
            timezone_id=TIMEZONE,
            user_agent=USER_AGENT,
            viewport=VIEWPORT,
            color_scheme="dark",
            device_scale_factor=2,
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        resumed = load_chat_url()
        start_url = resumed or START_URL
        emit("status", f"opening {start_url}")
        page.goto(start_url, wait_until="domcontentloaded")

        emit("status", "waiting for chat input (log in if prompted)...")
        for _ in range(180):
            if find_input(page): break
            time.sleep(1)
        else:
            emit("error", "chat input never appeared")
            return

        if resumed:
            emit("status", "resumed existing chat")
        else:
            emit("status", "sending system prompt...")
            prev = last_code_block(page)
            send_message(page, build_system_prompt())
            ack = wait_for_reply(page, prev, timeout=120)
            emit("status", f"model acknowledged: {(ack or '')[:80]}")
            save_chat_url(page)

        emit("status", "ready")
        STATE["mode"] = "idle"

        while True:
            task = INBOX.get()
            if task is None: break
            STATE["mode"] = "busy"
            try:
                run_task(page, task, cwd)
            except Exception as e:
                emit("error", f"agent error: {e}")
            STATE["mode"] = "idle"
            emit("status", "ready")

# ============================================================
# HTTP
# ============================================================
HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent</title>
<style>
  :root{
    --bg:#0d1117; --panel:#161b22; --border:#30363d;
    --text:#c9d1d9; --muted:#8b949e; --accent:#58a6ff;
    --user:#1f6feb; --cmd:#7ee787; --out:#8b949e; --err:#f85149;
    --ask:#d29922;
  }
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{
    background:var(--bg); color:var(--text);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    display:flex; flex-direction:column;
  }
  header{
    padding:12px 20px; border-bottom:1px solid var(--border);
    display:flex; align-items:center; gap:10px; background:var(--panel);
  }
  header .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);transition:background .2s}
  header .dot.busy{background:var(--ask);animation:pulse 1.4s infinite}
  header .dot.idle{background:var(--cmd)}
  header .dot.asking{background:var(--ask)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  header h1{font-size:14px;font-weight:600;margin:0;flex:1}
  header .btn{
    background:transparent;color:var(--muted);border:1px solid var(--border);
    border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;
  }
  header .btn:hover{color:var(--text);border-color:var(--muted)}
  main{flex:1;overflow-y:auto;padding:20px 0}
  .row{padding:6px 20px;display:flex}
  .row.user{justify-content:flex-end}
  .bubble{max-width:min(760px,80%);padding:10px 14px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word}
  .user .bubble{background:var(--user);color:white}
  .agent .bubble{background:var(--panel);border:1px solid var(--border)}
  .question .bubble{background:rgba(210,153,34,.1);border:1px solid var(--ask);color:var(--ask)}
  .question .bubble::before{content:"agent asks ";font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.5px}
  .status{padding:4px 20px;color:var(--muted);font-size:12px;font-style:italic}
  .status.ready{color:var(--cmd)}
  .status.error{color:var(--err);font-style:normal}
  body:not(.verbose) .cmd,
  body:not(.verbose) .output{display:none}
  .cmd{margin:6px 20px;background:#010409;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .cmd > .hdr{padding:4px 10px;font-size:11px;color:var(--muted);background:var(--panel);border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
  .cmd > pre{margin:0;padding:10px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--cmd);white-space:pre-wrap;word-wrap:break-word}
  .cmd.collapsed > pre{display:none}
  .output{margin:0 20px 6px;background:#0d1117;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .output > .hdr{padding:4px 10px;font-size:11px;color:var(--muted);background:var(--panel);border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
  .output > pre{margin:0;padding:10px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--out);white-space:pre-wrap;word-wrap:break-word;max-height:400px;overflow-y:auto}
  .output.collapsed > pre{display:none}
  footer{border-top:1px solid var(--border);background:var(--panel);padding:12px 20px;display:flex;gap:10px}
  footer textarea{flex:1;resize:none;height:44px;padding:10px 12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;font:14px/1.4 inherit;outline:none}
  footer textarea:focus{border-color:var(--accent)}
  footer button{padding:0 22px;border:0;border-radius:8px;background:var(--accent);color:white;font-weight:600;cursor:pointer}
  footer button:disabled{opacity:.4;cursor:default}
</style>
</head>
<body>
<header>
  <div class="dot idle" id="dot"></div>
  <h1>Adal Agent</h1>
  <button class="btn" id="verbose">Verbose</button>
  <button class="btn" id="newtask">New task</button>
  <button class="btn" id="newchat">New chat</button>
</header>
<main id="chat"></main>
<footer>
  <textarea id="input" placeholder="Type a task…"></textarea>
  <button id="send">Send</button>
</footer>
<script>
const chat=document.getElementById('chat'),input=document.getElementById('input'),
      send=document.getElementById('send'),dot=document.getElementById('dot');
function scroll(){chat.scrollTop=chat.scrollHeight}
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function addRow(kind,text){
  if(kind==='command'){
    const box=el('div','cmd');const hdr=el('div','hdr','command');hdr.onclick=()=>box.classList.toggle('collapsed');
    box.append(hdr,el('pre',null,text));chat.append(box);
  } else if(kind==='output'){
    const box=el('div','output');const hdr=el('div','hdr','output');hdr.onclick=()=>box.classList.toggle('collapsed');
    box.append(hdr,el('pre',null,text));chat.append(box);
  } else if(kind==='status'){
    const s=el('div','status',text);if(text==='ready')s.classList.add('ready');chat.append(s);
  } else if(kind==='error'){chat.append(el('div','status error',text))}
  else{const r=el('div','row '+kind);r.append(el('div','bubble',text));chat.append(r)}
  scroll();
}
const es=new EventSource('/events');
es.onmessage=e=>{
  const ev=JSON.parse(e.data);
  if(ev.kind==='status'){dot.className=ev.text==='ready'?'dot idle':(ev.text.includes('error')?'dot busy':'dot busy')}
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
vbtn.onclick=()=>{document.body.classList.toggle('verbose');
  vbtn.style.color=document.body.classList.contains('verbose')?'var(--accent)':'var(--muted)';
  chat.scrollTop=chat.scrollHeight;};
document.getElementById('newtask').onclick=()=>{addRow('status','── new task ──')};
document.getElementById('newchat').onclick=async()=>{await fetch('/newchat',{method:'POST'});
  addRow('status','chat reset — restart to open a fresh DeepSeek chat')};
input.focus();
</script>
</body>
</html>"""

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        if self.path=="/" or self.path.startswith("/?"):
            body=HTML.encode()
            self.send_response(200);self.send_header("Content-Type","text/html; charset=utf-8")
            self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body);return
        if self.path=="/events":
            self.send_response(200);self.send_header("Content-Type","text/event-stream")
            self.send_header("Cache-Control","no-cache");self.send_header("X-Accel-Buffering","no");self.end_headers()
            q=queue.Queue(maxsize=1000)
            with SUB_LOCK:SUBSCRIBERS.append(q)
            try:
                self.wfile.write(f"data: {json.dumps({'kind':'status','text':'connected','ts':time.time()})}\n\n".encode());self.wfile.flush()
                while True:
                    try:
                        ev=q.get(timeout=20)
                        self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode());self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n");self.wfile.flush()
            except (BrokenPipeError,ConnectionResetError):pass
            finally:
                with SUB_LOCK:
                    if q in SUBSCRIBERS:SUBSCRIBERS.remove(q)
            return
        self.send_response(404);self.end_headers()
    def do_POST(self):
        n=int(self.headers.get("Content-Length","0") or 0)
        raw=self.rfile.read(n) if n else b"{}"
        try:data=json.loads(raw.decode() or "{}")
        except Exception:data={}
        if self.path=="/send":
            t=(data.get("text") or "").strip()
            if t:INBOX.put(t)
            self.send_response(200);self.send_header("Content-Type","application/json");self.end_headers()
            self.wfile.write(b'{"ok":true}');return
        if self.path=="/newchat":
            try:
                p=Path(os.path.expanduser(CHAT_URL_FILE))
                if p.exists():p.unlink()
            except Exception:pass
            self.send_response(200);self.end_headers();self.wfile.write(b'{"ok":true}');return
        self.send_response(404);self.end_headers()

# ============================================================
# Entry
# ============================================================
def main():
    init_agent_dirs()
    threading.Thread(target=agent_thread,daemon=True).start()
    srv=ThreadingHTTPServer(("127.0.0.1",PORT),Handler)
    url=f"http://localhost:{PORT}"
    print(f"[webui] control panel: {url}")
    print(f"[webui] press Ctrl-C to stop")
    def open_browser():
        time.sleep(0.8)
        try:webbrowser.get("firefox").open(url)
        except Exception:
            try:webbrowser.open(url)
            except Exception:pass
    threading.Thread(target=open_browser,daemon=True).start()
    try:srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[webui] shutting down");INBOX.put(None)

if __name__ == "__main__":
    main()