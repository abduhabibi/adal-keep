---
name: whatsapp-always-on
description: Every WhatsApp account runs in its own hidden browser kept alive by keepConnected, never in the Adal Brave
metadata:
  type: project
---

Since 2026-11-04 (a75ae04) no WhatsApp account lives in the Adal Brave. Each runs headless in data/whatsapp/session-<key> (LocalAuth), and keepConnected() checks every 30 s. The old `brave` key in accounts.json now only says who owns old agents with a null user_key.

**Why:** the user complained about signing in every day; closing Brave dropped WhatsApp. The old Brave session is not carried over, so each account scans one last time.

**How to apply:** do not attach WhatsApp to getBrowser() again. Install-from-internet uses prebuilt Windows modules: scratch `npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64`, plus sqlite3's build/ folder from the older Windows zip. If sqlite3 changes version, it needs a fresh Windows build. Rebuild deps/backend-modules.zip whenever package-lock changes. [[tab-reuse]]

WhatsApp's unsigned page is now /login, which has no WAWebSocketModel, and whatsapp-web.js 1.34.7 breaks there. connect() wraps c.inject: it shows the page's QR (data-ref, else canvas) and ticks "Stay logged in". After the scan the library takes over. "Link with phone number" is not handled on that page. Scanning itself has not been tested by me.
