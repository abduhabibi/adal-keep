---
name: tab-reuse
description: Runs reuse a free tab on their own site instead of a new one; what counts as free; no-USB install route
metadata:
  type: project
---

Since 2026-11-04 (a45c1c2) openRunTab takes a free tab on the run's site (signed-in first), then the workflow goes to its page. Never taken: tabs in the registry, tabs named adal-run-N of a pending/running/paused run, a person's typed form, the front tab, or a run-driven tab touched in the last 60 s. Run-driven tabs always report "visible" (focus emulation), so those use the touch tracker instead.

**Why:** the user wants agents not to start from scratch. window.name is wiped on cross-site navigation, so it is rewritten on every load.

**How to apply:** a new portal must be added to RUN_HOSTS and RUN_PEERS. Background checks use borrowTab/doneWithTab, not newPage.

No-USB install: `node adal-keep-backend/scripts/publish-install.mjs [days]` uploads to the private `adal-install` bucket and prints an `irm … | iex` line. Installers hold ADAL_LICENSE_KEY: never put them on GitHub or in adal-updates. [[usb-workflow]] [[supabase-updates]]
