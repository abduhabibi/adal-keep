---
name: browser-opening-rule
description: Only a person's button may start Brave; background work uses openBrowserIfAny. Companion PCs fall back to the online copy
metadata:
  type: feedback
---

Background work (timers, watchers, retries, polled screens) must use `openBrowserIfAny()`, never `getBrowser()`, because getBrowser starts Brave when it is closed. Fixed 2026-11-04 (37cc80e) after the user saw windows opening by themselves, and Chrome coming back after they quit Adal Keep.

**Why:** closing the window does not stop the server (AdalKeep.exe keeps it running), so anything that starts the browser brings it back.

**How to apply:** new timers go through openBrowserIfAny. Employee PCs (Companion) must work from Supabase while the main PC is off: adal-launcher/online.go serves the phone pages on 127.0.0.1:47801. Those pages and AdalKeep.exe ship in the installer, not in Supabase releases, so changes to them need a reinstall. [[run-tabs-background]] [[usb-workflow]]

Update 2026-11-05: agents' windows are now off-screen, so the server starts the browser quietly at start (startBrowserQuietly). The rule still holds where the browser would be visible (old launcher, ADAL_HIDDEN_AGENTS off) and for timers. See [[adal-browser]].
