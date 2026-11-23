---
name: pc-access-gate
description: Since 2026-11-03 other computers must be approved on the main PC before they can open Adal Keep; Origin/Host checks block other websites
metadata:
  type: project
---

Since 2026-11-03 (backend networkGate.js, routes/pcAccess.js, frontend PcAccessGate.jsx) only loopback is trusted. Any other computer that calls /api or /uploads must hold a key the main PC approved (Yes/No popup; Settings → Agency lists the computers, with Remove). Keys are stored hashed in data/pc-access.json. Follower PCs' chat proxy sends `x-adal-pc` from `pc_key` in main-pc.json. Browser calls with a foreign Origin, or a foreign Host (DNS rebinding), get 403.

**Why:** the user asked to "make the whole system really secured". Before this, the LAN and Tailscale could read passports, portal passwords and the Musaned code.

**How to apply:** a new endpoint that other computers must reach before approval goes in networkGate's OPEN list. A new app origin (window or port) goes in OWN_ORIGINS. Portal passwords are still plain text in the DB.
