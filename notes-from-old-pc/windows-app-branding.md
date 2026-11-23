---
name: windows-app-branding
description: Windows Adal Keep must look like one Adal app — no command windows, Adal logo on the taskbar; still a normal Brave window with tabs
metadata:
  type: project
---

On 2026-10-19 the user asked that Adal Keep on Windows show only the Adal logo, with no cmd windows. It should still be a normal Brave window with tabs, following the same tab-not-window rule as before.

How it works:
- **Launcher:** AdalKeep.exe (adal-launcher, `-H windowsgui`) is a hidden supervisor, one copy per session. It keeps node running, which replaces run-server.bat, and starts the Companion and the agent hidden. Windows starts it at login with `--background`.
- **Taskbar logo (brand.go):** the launcher gives the Brave windows of the Adal Keep profile the Adal icon (WM_SETICON) and the AppUserModelID `AdalSoftware.AdalKeep`. The installer tags the shortcuts with that id via `--set-shortcut-ids`.
- **Logo in the programs:** the build writes adal.ico into AdalKeep.exe and adal-companion.exe through adal-installer/tools/seticon under Wine.
- **Companion:** built `-H windowsgui`, logs to companion.log, runs as a single instance.

**Why:** the user wants the product to look like their own app.

**How to apply:** keep `windowsHide: true` on every Node spawn or exec. The taskbar branding is only tested under Wine, not on real Windows; ask the user what the taskbar shows on Windows. Related: [[usb-workflow]].
