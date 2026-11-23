---
name: pixel8-emulator
description: Pixel_8 Android emulator on this PC for phone-app tests; adb must use port 15037 because Traccar holds 5001-5250
metadata:
  node_type: memory
  type: reference
  originSessionId: 34dad6a7-47f6-4b08-aa1e-28c40b058fb2
  modified: 2026-11-02T11:05:40.880Z
---

Pixel 8 test phone: AVD `Pixel_8` (Android 15 google_apis x86_64, 1080x2400 @420, made from the pixel_7 profile) in ~/Android/Sdk, created 2026-11-02.

- A **Traccar** service on this PC listens on ports 5001–5250, including adb's 5037 — plain `adb` hangs. Always `export ANDROID_ADB_SERVER_PORT=15037` and start the emulator with `-ports 5584,5585` (device `emulator-5584`), unsandboxed.
- Start: `emulator -avd Pixel_8 -no-snapshot-save -no-audio -gpu swiftshader_indirect -no-boot-anim -ports 5584,5585` (boots ~1 min; slow UI on this 4-core PC).
- To drive the app's pages, build once with `"webContentsDebuggingEnabled": true` in adal-phone/capacitor.config.json (never ship it), then `adb forward tcp:19333 localabstract:webview_devtools_remote_<pidof com.adalkeep.phone>` and connect puppeteer to http://localhost:19333.
- Never `pkill -f`/`pgrep -f` with a pattern in the command itself — use `pidof qemu-system-x86_64`.

Related: [[phone-app]]
