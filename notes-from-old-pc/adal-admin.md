---
name: adal-admin
description: "Adal Keep Admin is Adal's own supervisor app over all agencies — Work tab, per-agency Adal Keep windows on :4101, own desktop window"
metadata:
  node_type: memory
  type: project
  originSessionId: e9919e7d-7360-49b4-baf2-5f2a94df64bc
  modified: 2026-10-27T12:29:40.600Z
---

Since 2026-10-27 the user wants adal-admin to be the "real admin" that sees and controls every agency's work (they chose "see + act", "own window on this PC", "show agencies a notice").

- Work tab (GET /api/work) reads each agency's keep_meta '/_summary' (pushed by adal-keep-backend services/cloudSync.js) and '/_pc' heartbeat.
- Actions go through the relay (keep_calls, device_id = Adal's admin id → shown as "Adal support" on the agency PC).
- "Open Adal Keep" = adal-keep-frontend `npm run build:admin` → adal-admin/keep-app (gitignored), served on port 4101 with a /sb proxy that limits Supabase to the agency named in the apikey header.
- start-admin.sh rebuilds keep-app when frontend src changed and opens Brave `--app` with its own profile ~/.adal-keep/admin-window (class AdalKeepAdmin); app menu entry ~/.local/share/applications/adal-admin.desktop.

**Why:** Adal supervises agencies' overflow and acts for them.
**How to apply:** new agency features should also show up in the summary/Work tab when they matter for supervision. Never `pkill -f` with a pattern that also appears in the Bash command itself (it killed the shell twice). Related: [[phone-app]].

Update 2026-11-05: the user calls this app "Adal Keep main". Agents tab: every agency's foreign agents (name, number) from `/_summary`, plus Adal's own list in adal-admin/agents.json (gitignored). Drag or click an agent/CV template onto an agency: relay `/_adal/agents/*`, handled before the backup's "busy". Per-agency plan: settings `whatsapp_agent_limit`, set only through `/_adal`, because the user sells more agents for bigger offers. Templates travel without header images. Work tab has a "Needs you" list. Automated mouse drags don't start native HTML5 drag: test with DragEvent. Port 4190 is blocked by fetch; use 4188 for a throwaway Admin with ADMIN_PORT and ADMIN_PASSWORD_HASH env.
