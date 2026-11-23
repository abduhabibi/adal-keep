---
name: no-stored-auth
description: "Musaned authenticator IS allowed again (user asked 2026-11-03, per account, key locked on the PC); LMIS SMS codes are still typed by people"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 34dad6a7-47f6-4b08-aa1e-28c40b058fb2
  modified: 2026-11-03T10:18:38.289Z
---

On 2026-10-23 the user had the Musaned authenticator (TOTP/QR) and LMIS SMS forwarding removed ("if Adal Keep is hacked, stored secrets are a risk").

On 2026-11-03 the user asked for the Musaned authenticator back: upload the QR (drag and drop or choose a file) per Musaned account, Adal Keep types the code, so with an auto-passing reCAPTCHA no person is needed. Built as services/musanedTotp.js (key in secretStore, AES-GCM, machine key), Settings → Portals → Musaned authenticator, used by passOtp and the contract check's sign-in.

**Why:** fewer interruptions now outweigh the earlier worry; the user decided.

**How to apply:** the Musaned authenticator stays (don't remove it). Still don't add SMS forwarding or stored LMIS codes unless the user asks. Runs still share one sign-in (tabManager `signInTurn` / `borrowSignIn`). Related: [[run-tabs-background]].

Update 2026-11-05: one browser holds one Musaned session. musanedWorkflow.checkAccount reads `.dropdown-item.fw-bold` and re-signs in if it is another account; never show another account's code. Related: [[adal-browser]].

Update 2026-11-05: pressing Sign in in the live view copies the run's own account code (`personInput` in routes/automations.js; only on wahid.sa / musaned.com.sa). `typeAuthenticatorCode` waits up to 15s for the code box because the screen can classify as otp before the box exists; a paused run with a code box up and a key is resumed by `continueSignedIn`.

Update 2026-11-05 (later): the account check now opens Musaned's top-right menu to read the name, as the user asked. A wrong account is left by pressing Logout in a new hidden tab; clearing cookies is only the fallback. The sign-in itself stays in the run's own tab, because that is the tab the live view and notifications follow. The Logout link sits inside a list item: click the innermost element. Never click menu items when closing the menu.
