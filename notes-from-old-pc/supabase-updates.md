---
name: supabase-updates
description: Installed PCs/phones update from Supabase (signed releases) so the GitHub repo can go private; signing key ~/.adal-keep/update-signing.pem never regenerate
metadata:
  node_type: memory
  type: project
  originSessionId: a4d89f46-0ab8-44e4-a93d-312e0a0e98ee
  modified: 2026-10-30T08:48:29.571Z
---

Since 2026-10-30 installed PCs check Supabase Storage bucket `adal-updates` first (release/latest.json + release/<sha>.tar.gz), GitHub `release` branch only as fallback. Phones get the APK via a signed link (phone/).

- Publish: `node adal-keep-backend/scripts/publish-update.mjs` (needs a clean commit; builds frontend, signs, uploads with adal-admin/.env service key). Do this after each build that goes to agencies, in addition to pushing main+release while the repo is public.
- Signing key: `~/.adal-keep/update-signing.pem` (Ed25519). Never regenerate or commit — the public half is baked into every installed PC (src/services/updateChannel.js PUBLIC_KEY); a new key would make every PC refuse updates.
- Supabase side: adal-admin/supabase/updates.sql must have been run once in the SQL editor.
- Repo may go private only after Admin → Work shows every agency on a version with the Supabase updater (Version column ✓).

**Why:** user wants the repo private without stranding installed PCs.
**How to apply:** after rebuilds, publish too; follow [[usb-workflow]] for the USB.

Since 2026-11-03 (ae5d3ca) installed PCs and the phone app use Supabase ONLY — no GitHub fallback, because the repo is going private. GitHub is used only by a developer's git checkout (this dev PC).

Since 2026-11-03 the dev repo's .git/hooks/pre-push runs publish-update.mjs whenever HEAD is pushed (the user chose this over GitHub Actions, so the signing key stays on this PC). A failed publish doesn't block the push. ADAL_NO_PUBLISH=1 skips it. The user rejected storing a GitHub token in Supabase for devices: devices need no GitHub access.
