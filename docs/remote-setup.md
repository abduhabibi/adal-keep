# Remote setup (flags off by default)

**Agency config record** — table `agency_config` (one row per agency): agency e-mail, LMIS SMS number, EPRO signature (file in private bucket `agency-config`), CV templates on/off, staff roles, feature switches, licence summary (shown only; the signed licence in Plans still decides). Edited in Admin → **Setup** → Edit settings (saves a new version). Every PC pulls it every 10 min, keeps `data/agency-config.json`, works offline from it. Code: `services/agencyConfig.js`, `routes/agencyConfig.js`.

**First-run sign-up** — flag `agency_signup`: name, phone, e-mail → `agency_sign_up()` → row in `agency_signups` ("new"). Admin → Setup lists it ("new, waiting for setup"); *Start setup* → *Ready* (tells the agency in its Adal inbox; the app shows a banner).

**Flags** (this PC, until the pitch is over they stay off): `ADAL_FLAG_AGENCY_CONFIG=1`, `ADAL_FLAG_AGENCY_SIGNUP=1` in `.env`, or `data/flags.json` `{"agency_config":true,"agency_signup":true}`. Per-agency switches (`features` in the record) only count when `agency_config` is on.

**One-time Supabase step:** run `adal-admin/supabase/agency-config.sql` in the SQL Editor.

**Website** — `website/pages` (static), `website/functions/api/download.js` (signed links, download codes from `install_codes`), `website/deploy.sh`. Publish the downloadable installer with `ADAL_SITE_PUBLISH=1 node adal-keep-backend/scripts/publish-install.mjs 30` (writes `site/install-x64.ps1`; re-run before its inner links expire). No 32-bit build exists yet (`site/install-x86.ps1` missing → the page says so).
