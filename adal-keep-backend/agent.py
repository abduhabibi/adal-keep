#!/usr/bin/env python3
"""
Personal agent — DeepSeek browser loop with SQLite long-term memory.
Uses a stealth-configured Firefox instead of Chromium.
"""

import os, re, sys, time, random, sqlite3, subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

# ============================================================
# CONFIG
# ============================================================
FIREFOX_PATH     = "/usr/local/bin/firefox"      # or /snap/bin/firefox
PROFILE_DIR      = "~/.deepseek_agent_profile_fx"
START_URL        = "https://chat.deepseek.com"

WORKDIR          = "~"
AGENT_DIR        = "~/.agent"
CONTEXT_DIR      = "~/.agent/context"
BIN_DIR          = "~/.agent/bin"
GENERAL_DB       = "general.db"
INDEX_DB         = "_index.db"

CMD_TIMEOUT      = 60
RESPONSE_TIMEOUT = 300
STABLE_SECONDS   = 2.5
MAX_STEPS        = 60
OUTPUT_LIMIT     = 4000
MAX_GENERAL_CHARS = 20_000

INPUT_SELECTORS  = ["textarea", "div[contenteditable='true']", "[role='textbox']"]
CODE_SELECTORS   = ["pre code", "pre"]

# ---------- stealth / fingerprint ----------
LOCALE           = "en-US"
TIMEZONE         = "Africa/Addis_Ababa"
USER_AGENT       = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) "
    "Gecko/20100101 Firefox/133.0"
)
VIEWPORT         = {"width": 1440, "height": 900}

FIREFOX_PREFS = {
    # --- kill the automation tells ---
    "dom.webdriver.enabled": False,
    "useAutomationExtension": False,
    "remote.enabled": False,
    "remote.active-protocols": 0,
    "marionette.enabled": False,
    # --- plausible real-user surface ---
    "dom.webnotifications.enabled": False,
    "media.navigator.enabled": False,
    "media.peerconnection.enabled": False,
    "media.webspeech.recognition.enable": False,
    "media.webspeech.synth.enabled": False,
    "device.sensors.enabled": False,
    "dom.battery.enabled": False,
    "dom.gamepad.enabled": False,
    "geo.enabled": False,
    # --- network / telemetry quiet ---
    "network.http.referer.XOriginTrimmingPolicy": 2,
    "network.http.referer.XOriginPolicy": 2,
    "network.trr.mode": 5,
    "beacon.enabled": False,
    "browser.send_pings": False,
    "browser.send_pings.require_same_host": True,
    "toolkit.telemetry.enabled": False,
    "datareporting.healthreport.uploadEnabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "app.shield.optoutstudies.enabled": False,
    "browser.newtabpage.activity-stream.feeds.telemetry": False,
    # --- kill headless-ish / automation traits ---
    "privacy.resistFingerprinting": False,   # must stay false — it normalizes and looks wrong
    "privacy.trackingprotection.enabled": True,
    "dom.max_script_run_time": 0,
    "browser.startup.page": 3,
    "browser.startup.homepage": "about:blank",
    "browser.tabs.warnOnClose": False,
    "browser.tabs.warnOnCloseOtherTabs": False,
    "browser.warnOnQuit": False,
    "dom.disable_beforeunload": True,
    "pdfjs.disabled": True,
    # --- fonts / canvas stability ---
    "gfx.downloadable_fonts.enabled": True,
    "gfx.font_rendering.opentype_svg.enabled": True,
    "webgl.disabled": False,
    "webgl.enable-webgl2": True,
    "layers.acceleration.force-enabled": True,
}

FIREFOX_ARGS = [
    "--no-remote",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--disable-features=TranslateUI",
    "--no-first-run",
    "--no-default-browser-check",
]

# ============================================================
# Schemas / defaults
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

# ============================================================
# Helper scripts
# ============================================================
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
# Bootstrap
# ============================================================
def log(msg): print(f"[agent] {msg}", file=sys.stderr, flush=True)

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
        conn = sqlite3.connect(db)
        conn.executescript(FACTS_SCHEMA)
        conn.commit(); conn.close()

    files = {"remember.sh": HELPER_REMEMBER,
             "recall.sh":   HELPER_RECALL,
             "newdomain.sh":HELPER_NEWDOMAIN}
    for name, body in files.items():
        p = Path(os.path.expanduser(BIN_DIR)) / name
        p.write_text(body)
        p.chmod(0o755)

# ============================================================
# Context loading
# ============================================================
def dump_general(limit=MAX_GENERAL_CHARS):
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
    return f"""You are the user's personal agent, running on their machine as `{os.getenv('USER','user')}`.

You have full read/write access to the filesystem. You decide what to do.

MEMORY SYSTEM
Your long-term memory is a set of SQLite databases at {CONTEXT_DIR}.
Every database has this schema:
    CREATE TABLE facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

Available domains:
{dump_domains()}

Only `general.db` is pre-loaded (below). Other domains are queried on demand.

HELPER SCRIPTS
Read:      {BIN_DIR}/recall.sh <domain> <search>
Write:     {BIN_DIR}/remember.sh <domain> "<topic>" "<content>" "<tags>"
New domain:{BIN_DIR}/newdomain.sh <name> "<description>"

RULES
- ALWAYS consult the general context below before acting.
- Before answering a non-trivial question, query the relevant domain(s) with recall.sh.
- After finishing a task, if you learned something durable about the user, save it.
- One fact per row. Plain English. Short.
- Never use sudo. Never touch /etc, /usr, /boot.
- If a destructive command is needed, ask first via: echo ASK: <question>

REPLY PROTOCOL
- Reply with EXACTLY ONE fenced code block (```bash ... ```). Nothing outside it.
- To finish, end the block with:  echo DONE
- To ask the user something, run: echo ASK: <question>
- Working directory: {os.path.expanduser(WORKDIR)}

=== GENERAL CONTEXT (general.db, already loaded) ===
{dump_general()}
=== END GENERAL CONTEXT ===
"""

# ============================================================
# Browser
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

def human_pause(lo=120, hi=420):
    time.sleep(random.uniform(lo, hi) / 1000.0)

def send_message(page, text):
    box = find_input(page)
    if not box: raise RuntimeError("chat input not found")
    box.click()
    human_pause()
    page.keyboard.insert_text(text)
    human_pause(250, 650)
    page.keyboard.press("Enter")

def wait_for_reply(page, prev, timeout=RESPONSE_TIMEOUT):
    last, since, start = None, None, time.time()
    while time.time() - start < timeout:
        txt = last_code_block(page)
        if txt and txt != prev:
            if txt != last:
                last, since = txt, time.time()
            elif since and (time.time() - since) >= STABLE_SECONDS:
                return txt
        time.sleep(0.4)
    return last

# ============================================================
# Execution
# ============================================================
def truncate(s, n=OUTPUT_LIMIT):
    return s if len(s) <= n else s[:n] + f"\n...[truncated {len(s)-n} chars]"

def run_code(code, cwd):
    try:
        r = subprocess.run(["bash","-c",code], capture_output=True, text=True,
                           timeout=CMD_TIMEOUT, cwd=str(cwd))
        return r.stdout, r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        return "", f"[timeout after {CMD_TIMEOUT}s]", 124

# ============================================================
# Agent loop
# ============================================================
def run_task(page, task, cwd):
    log(f"task: {task}")
    prev = last_code_block(page)
    send_message(page, task)

    for step in range(1, MAX_STEPS + 1):
        code = wait_for_reply(page, prev)
        if not code:
            log("no reply — stopping")
            return
        code = code.strip(); prev = code
        log(f"--- step {step} ---"); log(code)

        if re.search(r"\becho\s+DONE\b", code) and len(code) < 250:
            out, _, _ = run_code(code, cwd)
            print(out.replace("DONE","").strip())
            log("task complete"); return

        if "ASK:" in code:
            out, _, _ = run_code(code, cwd)
            q = out.replace("ASK:","").strip()
            print(f"\n[agent asks] {q}")
            try: reply = input("> ").strip()
            except EOFError: reply = ""
            prev = last_code_block(page)
            send_message(page, reply or "(no answer, continue)")
            continue

        out, err, rc = run_code(code, cwd)
        if out.strip(): print(out, end="" if out.endswith("\n") else "\n")
        if err.strip(): print(err, file=sys.stderr, end="" if err.endswith("\n") else "\n")

        prev = last_code_block(page)
        send_message(page, f"exit={rc}\nstdout:\n{truncate(out)}\nstderr:\n{truncate(err)}")

    log(f"hit MAX_STEPS ({MAX_STEPS})")

# ============================================================
# Entry
# ============================================================
def main():
    init_agent_dirs()
    cwd = Path(os.path.expanduser(WORKDIR))
    log(f"agent dir: {os.path.expanduser(AGENT_DIR)}")
    log(f"working directory: {cwd}")
    log(f"firefox: {FIREFOX_PATH}")

    task = " ".join(sys.argv[1:]).strip()

    with sync_playwright() as p:
        ctx = p.firefox.launch_persistent_context(
            user_data_dir=os.path.expanduser(PROFILE_DIR),
            headless=False,
            # executable_path=FIREFOX_PATH,  # use Playwright bundled Firefox
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
        page.goto(START_URL, wait_until="domcontentloaded")

        log("waiting for chat input (log in if prompted)...")
        for _ in range(180):
            if find_input(page): break
            time.sleep(1)
        else:
            log("chat input never appeared"); ctx.close(); return

        log("sending system prompt...")
        prev = last_code_block(page)
        send_message(page, build_system_prompt())
        ack = wait_for_reply(page, prev, timeout=120)
        log(f"model acknowledged: {ack!r}")

        if not task:
            try: task = input("Task: ").strip()
            except EOFError: task = ""
        if not task:
            log("no task — exiting"); ctx.close(); return

        run_task(page, task, cwd)

        while True:
            try: nxt = input("\nNext task (blank to quit): ").strip()
            except EOFError: break
            if not nxt: break
            run_task(page, nxt, cwd)

        log("bye")
        ctx.close()

if __name__ == "__main__":
    main()