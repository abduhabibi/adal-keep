---
name: adal-browser
description: Adal's own Chromium, agents off-screen, no pop-ups, one beep, notification bar with captcha input, app window separate
metadata:
  type: project
---

Since 2026-11-04 (f7eb45e), and per the user's direction:
- Adal Browser is ungoogled-chromium, pinned in adal-launcher/browser.go and fetched by ensureBrowser to <install>\browser\AdalBrowser.exe. It is not compiled by us. Profile is data/adal-browser, because Brave's profile may be from a newer version.
- Agents run in one off-screen window; brand.go hideAgents takes it off the taskbar. Only the notification's Open (showTab) brings a tab forward. setupTab turns page.bringToFront into a no-op.
- This needs the new launcher, which sets ADAL_HIDDEN_AGENTS=1. Old launchers open the page inside the agents' browser, so hiding stays off there.
- Adal Keep's window is an --app window with its own ui-profile. Only the icon opens it. Opening at PC start is off until allowed in Settings.
- No pop-ups of any kind: no voice, no ElevenLabs, no alarm, no balloon. beep() is the only sound.
- attention.js + AttentionBar: picture captcha shows with an input and the run finishes itself. Save stays a person's. Done for the visa platform only so far.
- LMIS contract is removed from the UI, journey and scanner; lmisContract.js code is left unreachable.

**Why:** the user wants no windows ever and to type captchas from the notification, with the tab kept for later runs ([[tab-reuse]]).

**How to apply:** a new sound, window or bringToFront breaks this rule. A new picture-captcha portal uses ctx.askCaptcha.

Update 2026-11-04: Adal Keep's window goes through the launcher's door at 127.0.0.1:47802 (appwindow.go), which proxies to :4000 and shows a starting page while the server is down. It must clear X-Forwarded-For or onThisPC refuses. A person works in tabs via LiveTab in the card or in a full overlay, not by showing the browser window. The agents' window is a tool window, never hidden: a hidden window stops drawing and the live view dies. The user asked to automate reCAPTCHA; I declined (bot-check bypass). A person ticks it through LiveTab.

Update 2026-11-05: adal-installer/pack-browser.sh packs the pinned build with the Adal logo into deps/adal-browser.zip (top folder browser\); both installers and the internet line carry it, ensureBrowser is only the fallback. Bumping the version in browser.go repacks on the next build. A sidebar button opens it. Patched exe tested under Wine (starts, answers CDP). Over-the-air updates do not carry .exe files, so launcher and Companion fixes need a reinstall.

Update 2026-11-05 (later): each run tab opens in its own off-screen window (browser.js newRunTab), a person's button opens a separate on-screen window (openForPerson), and agents' windows never move on screen; showTab is gone. The browser starts quietly with the server when hidden (startBrowserQuietly), which replaces the old "only a person's button starts it" rule for hidden mode. attention.js asks codes as well as captchas (askCaptcha with image null); confirm calls stay until Done.

Update 2026-11-05: this dev PC is Wayland, which ignores window positions, so off-screen never worked here and setWindowBounds shrank windows. On Linux run windows are minimized (works, screenshots and timers keep going); never call place() on a person's window.

Update 2026-11-05 (latest): one agents' window only. browser.js keeps a blank anchor tab (window.name adal-agents-window); newRunTab opens tabs from it with window.open and a user gesture, so no new OS window. Never use newWindow for runs. Background tabs still screenshot, scroll and click (tested).
