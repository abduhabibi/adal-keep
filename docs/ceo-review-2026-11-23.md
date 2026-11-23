# CEO review — Adal Keep from first principles (2026-11-23)

Read-only review of `origin/main` at 16006c5 (576 commits since 2026-07-23; 311 in the last 8 days; 57 on 11-23 alone).
Five parallel reviews (robots, sync/install/cloud, security/billing, product/admin/phone, code health) plus my own reading of docs/, CLAIMS.md, the sibling notes and git history.
Nothing in the code was changed.

> **Note on security items.** This repository is treated as public (see the comment in `adal-installer/build-installer.sh`).
> Security findings are only named here, not described. The details are in the private session-notes folder
> (`ceo-review-security.md`), not in git. Read that before starting items 2, 3 and 9.

---

## 1. The verdict in one page

**What is genuinely strong.** Adal Keep already does the hard, unglamorous work no competitor wants to do: it reads a passport in ~0.4 s, it makes the CV, and it drives Musaned, LMIS, Wafid, Enjaz, Tasheer and insurance. It has a phone app that forwards LMIS SMS codes to the robot, signed updates with delta patches and auto-undo, an Admin panel, run history with stop pictures, staff roles and consent/export/erase. For a one-person company that is remarkable. The product-market insight is correct: Ethiopian agencies spend staff hours typing the same worker into five Saudi/Ethiopian portals, and they pay for anything that removes that.

**What will kill it if nothing changes.** The risk is not missing features. It is **too much unproven machinery shipped too fast to too few, weak PCs, with security gaps that one curious customer could find.**
- About 20 Claude sessions push to `main`. **Every push publishes to every agency PC at once** (`.git/hooks/pre-push` → `publish-update.mjs`; staging is opt-in with `--staged`).
- A distributed database with field-level merges, an automatic leader lease and seven sync and failover paths was turned **on for every agency** on 11-23. It has **not yet run on Windows**, and the only live customer runs on a 2-core Main PC.
- 157 `ADAL_*` env names exist, and roughly a dozen headline features are "ON MAIN, RELEASE PENDING" behind flags.
- The frontend has 0 tests, there is no CI, and the test suite was not green on the released commit (`signInReuse` flaky, `tasheerUpload` failing; see sibling notes).
- Security hardening is needed before the second agency (items 2, 3, 9; details kept out of this public repo).

**The strategy in one sentence:** for the next 30 days, *stop adding and start proving*. Make one Main + Companion setup boringly reliable, make the robots measurably faster than a person with a stopwatch, close the security holes, and make pricing and onboarding self-explanatory. Then sell to 10 agencies before building anything new.

---

## 2. For tomorrow's pitch: "Adal Keep's robots do tasks faster than a human"

What is true today and safe to claim:
- **Passport → filled profile in under a second** (measured, `docs/speed.md` #1: 430 ms warm). A person types it in about 8 minutes.
- **CV ready on click** (pre-rendered; PDF download ~1 ms when prepared).
- **"Add from Musaned"**: 25 s → 2.8 s on first lookup, 0.8 s when cached. *This was measured on a mock HR Pool, not live Musaned.* Say "seconds", not "0.8 s".
- **The robot types while your staff do something else.** This is the strongest honest claim: the person's time per run drops to "type one code", even if the robot itself takes a minute or two.

What is not yet safe to claim:
- That **Musaned Add Candidate** is faster than a skilled clerk *end to end*. It still has **about 45–55 s of fixed sleeps** (103 literal sleeps in `musanedWorkflow.js`, ~64 s in total), plus four full-page diagnostic dumps on every successful run.
- "Hours saved". `MANUAL_MINUTES` in `services/bizStats.js:23` is an estimate typed by hand, not a measurement.

**Do this before the pitch (S, a few hours, no risk to agencies):**
1. **Demo on the demo build, not the live agency.** `vite build --mode demo` (`adal-keep-frontend/src/demo/*`) has 16 made-up workers and simulated robots, and needs no server. It is the best sales asset in the repo and it cannot break or leak anything. Make the website's "Try the demo" point to it; it currently points to a stale mock-up in `website/pages/demo.html`.
2. **A side-by-side stopwatch video** from a test profile: a person types passport → profile → CV, while Adal Keep does the same in seconds. Film it once and use it everywhere.
3. **One pricing slide** that matches the code you will ship (item 6): Premium 49,999 ETB / 6 months, 89,999 ETB / 12 months, 3 PCs included, +2,500 ETB per extra PC per 6 months, 21 days free. The lock screen still says 30,000 ETB, so don't show it.
4. **Hardware line:** "The main PC needs 4 cores / 8 GB." The live agency's 2-core Main is the main source of slowness. Say it up front and turn it into an upsell (we bring a mini-PC: see item 11).

---

## 3. Ranked changes (biggest leverage first)

Effort: **S** ≤ 1 day · **M** 2–5 days · **L** 1–3 weeks. Impact tags: **Speed**, **Customers**, **Scale**, **Survival**.

### 1. Make releases safe: no auto-publish on push, staged by default, a release train — S · Survival, Customers
- **Problem.** The pre-push hook publishes every push of `main` to every PC (`.git/hooks/pre-push`), and the default rollout is "every PC at once" (`publish-update.mjs:87-88`). With ~20 sessions pushing, the only customer receives several untested releases a day. `--skip-tests` exists, and rollback is refused once a migration has run (`services/rollback.js:62-69`), which is exactly when you would need it. Agencies judge you on "it worked yesterday and today it didn't".
- **Change.**
  - Remove the publish step from the pre-push hook. Publish only with an explicit `node publish-update.mjs` from a clean worktree.
  - Make `--staged` the default: Test agency → 1 real agency → everyone, with at least 24 h between stages.
  - Hold at most **one release a day** (a release train), cut from a `release` branch after the Windows 3-PC check passes.
  - Make migrations *expand-only* (add columns and tables, never drop or rename within one release), so rollback is always allowed.
  - Delete `--skip-tests`, or require a typed reason that is logged.
- **Files.** `.git/hooks/pre-push` (local, outside git), `adal-keep-backend/scripts/publish-update.mjs`, `services/rollback.js`, `scripts/release-gate.mjs`, `docs/CLAIMS.md`.

### 2. Security hardening, part 1: who may reach an agency's data — M · Survival
- **Problem.** The data is worker passports, photos, medical results and portal passwords. The review found access-control gaps in pairing, the office-network API and file serving that must be closed before a second agency goes live. They are listed with exact locations in the private session note `ceo-review-security.md`, which is deliberately kept out of this public repository.
- **Change.** Follow that note in order. In product terms: joining a phone or PC needs a one-time code **and** a signed-in person's yes (or password); only the PC itself is trusted as the PC; every data request needs a staff sign-in; the office firewall rule covers the office network only.
- **Files.** Pairing, network gate, staff roles, PC access and installer firewall code (see the note).

### 3. Security hardening, part 2: per-install secrets and signed licences — M · Survival, Revenue
- **Problem.** The installer build carries settings that should exist only on Adal's own PC. Licences, sessions, AI access and the document store all depend on them. Details: the private note.
- **Change.**
  - Licences become **Ed25519-signed licence files only** (`plans.js` already verifies signed licences; the same model as `update-signing.pem`).
  - Per-install secrets are generated on first start.
  - AI calls go through a small server-side proxy (the Netlify function already in `adal-refine/`) with a per-agency quota.
  - Documents go to per-agency storage (Supabase Storage / Cloudflare R2 folders) instead of one shared channel.
  - **Rotate every key that has ever shipped.**
- **Files.** `adal-installer/build-installer.sh` and the licence, session and storage services (see the note).

### 4. Robot speed: delete the fixed waits, then prove it with a stopwatch — M · Speed (the pitch)
*(A separate session is rebuilding robot speed. These are my recommendations for it, ranked; see §5.)*
- **Problem.** The robots are slow for reasons in our own code, not the portals:
  - **Musaned Add Candidate: about 45–55 s of fixed sleeps per run.** Skills 6 × 2.35 s, dropdowns 4 × 2.6 s, text fields 12 × 0.6–0.9 s, photo 5–7 s, `MODAL_CLOSED_SETTLE_MS = 2000`, `toEnglish` 3 s, `verifyAndRefill` `1500*pass`.
  - **4 full-page PNG + HTML dumps on every *successful* run**, and each log line rewrites the whole log JSON in SQLite (`worker.js:204-211`).
  - **Remote AI (JEV) screen checks on the critical path, inside polling loops**, before the local check (`musanedWorkflow.js:307`, timeout 15 s). `reviewStageComplete` is a remote call whose answer is only logged.
  - Every request goes through Node interception, and images and fonts stay allowed all run on captcha sites.
  - **The browser quits after 10 idle minutes**, so the next run pays 10–40 s to start it.
  - Wafid has a `sleep(20000)`. Visa has 4–5 s sleeps after Login and Search. LMIS waits 3 s to confirm sign-in and types at 30 ms per character.
  - The passport picture is uploaded unresized (3–5 MB), and the LMIS passport PDF is re-made on every run.
- **Change.**
  1. Replace sleeps with DOM conditions (the pattern already exists as LMIS `settle()`).
  2. Dump diagnostics only on failure, and batch log writes (buffer and flush every 1 s).
  3. Run the local screen check first; call JEV only when the result is "unknown". Delete `reviewStageComplete`.
  4. Block resources with `Network.setBlockedURLs` instead of interception, and allow images only while a captcha shows.
  5. Keep the browser warm during office hours, 08:00–18:00.
  6. Resize the passport picture to ≤1600 px / ≤500 KB once, at upload, and cache the LMIS PDF by file hash.
  7. Use the site's own data calls (already learned in `siteApi.js`) for read-only steps: check chosen, search, contract.
- **Proof.** Store `activeMs` (robot-only time, `runLimit.js:30`, computed but never saved) and per-step times in `run_history`. Show "Robot: 1 m 12 s · A person: ~15 min (measured)" on the run page.
- **Files.** `services/{musanedWorkflow,lmisWorkflow,mofaVisa,wafidWorkflow,tasheer,musanedContracts,tabManager,sessionKeeper,worker,runHistory,runLimit,jev/client}.js`, migration for `run_history.active_ms` + `steps_json`.

### 5. Put the Companion full copy back behind a switch until Windows proves it — S · Survival
- **Problem.** The full-copy sync engine (field-level log, HLC, merges, automatic main-role lease) is the most complex thing in the product. It was turned on for everyone on 11-23, while the Windows sync test in CLAIMS.md is still an empty PASS/FAIL table.
  - Known open issues (`docs/companion-full.md`): a LAN split with no internet creates **two Mains, both running robots, WhatsApp and backups**; wrong PC clocks decide conflicts; portal passwords typed on a Companion sit in plain text in `sync_log` for up to an hour; one log entry per column (~1k entries/s on a strong PC, so slower on the agency Main).
- **Change.**
  - Default OFF again, ON per agency only after the 3-PC Windows test passes on that agency's PCs.
  - **No automatic role move**: moving Main is a button that a person presses (with "Main has been silent 15 min — make this PC Main?").
  - Never let two holders run robots: the role moves only with internet confirmation (a Supabase row as the lock), or by a person.
  - Encrypt vault rows inside `sync_log`.
- **Files.** `services/sync/{roles,index,node,engine}.js`, `adal-companion/full.go`, `data/flags.json` defaults, `docs/companion-full.md`.

### 6. One price, everywhere, enforced by a signed licence — S · Revenue, Customers
- **Problem.** The backend has the new plan (`services/billing.js:30-33`: 49,999 / 89,999 / 2,500 / 3 PCs), but only behind the `billing` flag, which is off. Everywhere else:
  - The lock screen falls back to **30,000 ETB** (`LockScreen.jsx:172,241`), and its payment image alt text still says 30,000.
  - `subscription.js:55` has `PRICE_ETB = 30000`, which also feeds the renewal reminder.
  - The "10% to charity" line uses a different number from the price shown above it.
  - An Authenticator code always adds 182 days, so a 12-month payment needs two codes.
  - **Extra PCs are not counted or limited.**
  - The trial is decided on the PC alone.
  - `/billing` is not in the sidebar. **The website shows no price.**
- **Change.**
  - Turn `billing` on for everyone and delete the 30,000 constants, image and fallback.
  - A licence = a signed file `{agency, until, pcs}` that Main enforces when a PC joins.
  - Anchor the trial start in the cloud (first-seen date, signed by Admin).
  - Put the price table on the website.
  - Add online payment through **Chapa or telebirr** (both have merchant APIs) so a renewal at 23:00 doesn't wait for the owner.
- **Files.** `services/{subscription,billing,plans}.js`, `components/LockScreen.jsx`, `components/PaymentInstructions.jsx`, `components/layout/Sidebar.jsx`, `website/pages/index.html`, `adal-admin/server.mjs` (billing).

### 7. Self-serve onboarding: download → working in 30 minutes without the owner — M · Customers, Scale
- **Problem.** First-run (`pages/IntroWizard.jsx`) asks a customer for a **"Developer Master Password"** and promises a **7-day** trial (the real one is 21). The better flow (`SignUpAgency.jsx` + Admin → Setup) is behind `agency_signup`, off, and its SQL (`adal-admin/supabase/agency-config.sql`) has not been run. Downloads need a code from the owner. The "backend not reachable" screen tells customers to run `npm run dev`. **Every new agency needs the owner on the phone, and that caps you at roughly 10 agencies.**
- **Change.**
  - Run the SQL and turn on `agency_signup` + `agency_config`.
  - Delete the master-password step and fix the trial text.
  - First-run checklist inside the app: 1) agency details, 2) add staff, 3) connect the phone, 4) scan the first passport, 5) first CV, 6) link Musaned. Show progress in Admin.
  - Measure **time-to-first-profile** per agency.
  - Keep download codes (they stop strangers), but let the website issue one automatically after a sign-up form, rate-limited.
  - Replace developer-facing error text with "Call Adal: 0995 668 080" plus the Help button.
- **Files.** `adal-keep-frontend/src/pages/{IntroWizard,SignUpAgency}.jsx`, `App.jsx`, `services/agencyConfig.js`, `adal-admin/supabase/agency-config.sql`, `website/functions/api/download.js`.

### 8. Delete and simplify: one sync engine, one updater, one Companion — M · Survival, Speed of development
- **Problem.** There are **seven** sync and failover mechanisms: the LAN CRDT log, the Supabase relay of it, cloudSync `keep_meta` copies + `keep_changes`, the `keep_calls` RPC, the Go Companion's locked replica (`replica.go`, 793 lines), the Go standby with merge-back (`standby.go`, 951 lines, its own UDP vote), and equal-PCs certificates (flag off, never deployed). There are two kinds of Companion plus the old "follower" mode. Update logic is written twice (JS and Go `selfupdate.go`, 1,260 lines), as is a dead GitHub update path. Every one of these is code that one person must keep correct on weak Windows PCs.
- **Change.**
  - Choose **(a) LAN log + (b) relay + (c) cloudSync for phones**.
  - Delete `replica.go`, `standby.go` merge-back, the follower mode, the GitHub updater, `ADAL_LAN_RELEASE_DIR` (LAN updates were removed) and **equal-PCs** (park the branch; revisit at 100 agencies).
  - The Go Companion becomes a thin launcher for the same Node server as Main: one program, one installer with a role choice.
  - Move the Go helpers copied between launcher and companion (`cleanold`, `crashreport`, `support`) into one module.
- **Files.** `adal-companion/{replica,standby,mainproxy,discovery,presence,mainid}.go`, `adal-launcher/employee.go`, `adal-keep-backend/src/services/sync/{trust,authority,equal}.js`, `routes/systemUpdate.js` (GitHub path), `services/lanRelease.js`.

### 9. Remote support: per-agency, opt-in, consented — S · Survival, Trust
- **Problem.** Remote-support access is set up the same way on every agency PC, and agencies are not shown a switch for it. Details: the private note.
- **Change.**
  - A key per agency (already half-built: `support-keys/<agency>.pub`).
  - A visible "Allow Adal support" switch, with written consent in the contract and a log of every session.
  - Pinned, hash-checked downloads in the installer.
  - Prefer the control tower's signed commands (already built) over SSH for routine support.
- **Files.** `adal-installer/files/`, `adal-installer/usb/deps/`, `services/tower.js`.

### 10. Make the cloud ready for 50 agencies (and cheap at 500) — M · Scale
- **Problem.**
  - The Main PC upserts a heartbeat every 15 s, about 2.9 M writes/day at 500 agencies. Admin polls Supabase every second.
  - `keep_meta` holds 9 rows per profile, plus whole `/profiles` and `/dashboard` JSON lists rewritten on every change.
  - Relay storage (`sync/*`, `sync-docs/*`) is **never deleted**.
  - One Realtime socket per PC and phone means the free tier's 200 connections break at about 50–100 agencies. The free tier also pauses idle projects.
  - The control tower, crash reports, tickets and business stats all live in `keep_meta` with "no new SQL": no indexes, no constraints.
  - Admin runs on the owner's PC. When it is off, no payment can be confirmed and no ticket is answered.
- **Change.**
  - **Supabase Pro now** (~$25/month; a rounding error against one licence).
  - Heartbeat every 60 s; Admin uses Realtime or 10 s polling.
  - Relay cleanup after every PC has acked.
  - Real tables for `tower_beats`, `tower_cmds`, `tickets`, `stats_daily`, `licences`, `payments`.
  - Move the Admin *server* parts (approvals, payment confirmations, ticket intake) into Supabase Edge Functions or a small always-on host, so the business runs while the owner's laptop sleeps.
- **Files.** `services/{cloudSync,tower,bizStats,liveChannel,agencyConfig}.js`, `services/sync/relay.js`, `adal-admin/{server,tower,home}.mjs`, `adal-admin/supabase/*.sql`.

### 11. Own the hardware problem: sell a "Main box" — S (decision) / M (ops) · Speed, Customers
- **Problem.** The only live Main is 2-core. Most "robots are slow" or "robot browser does not answer" reports trace back to it: a 7-s PowerShell port check, the 10-minute limit hit, the memory guard. The weak-PC gate (`ADAL_HW_GATE`) only moves robots when a stronger PC is on.
- **Change.** Offer a **pre-installed mini-PC** (4–8 cores, 16 GB, SSD, ~30–40k ETB) as the agency's Main, sold or leased with the plan. It is installed in one visit, the same image everywhere, with remote support built in, and it's the fastest way to make "faster than a human" true for every agency. Keep the cloud runner (`docs/cloud-runner-plan.md`) as phase 2, once Saudi portals are proven to accept a datacentre IP.
- **Files.** `website/pages/index.html` (requirements), `adal-installer/` (an image/preset for the box), `services/hardware.js`.

### 12. Data protection that you can show a partner — M · Customers (bigger agencies), Survival
- **Problem.**
  - Passport scans and photos are stored unencrypted on disk (`data/SafeStorage`, `/uploads`), and SQLite is unencrypted.
  - The online "keep" bucket is not client-side encrypted.
  - The backup key sits in the cloud next to the backups unless `ADAL_BACKUP_SEAL=1` (off).
  - Passport images go to foreign AI providers (Gemini, DeepSeek, xAI, MinerU), and there is no notice to candidates or processing agreement.
  - There is no retention rule.
  - Health data (Wafid medicals) is sensitive data under Ethiopia's Personal Data Protection Proclamation No. 1321/2024. Agencies are the controllers; Adal is the processor.
- **Change.**
  - Turn `ADAL_BACKUP_SEAL` on.
  - Use Windows BitLocker or EFS on the data folder, set up by the installer (cheap, big win).
  - Encrypt documents in the online bucket with the agency key, which phones already hold.
  - Prefer the local MRZ reader and send to AI only when it fails, then **strip the photo** (send only the MRZ/text crop).
  - Add a one-page **DPA + candidate notice** in Amharic and English, and a retention setting (e.g. erase 2 years after departure).
- **Files.** `services/{backupSeal,telegramBackup,dataRights,passportOcr,aiIngestion,geminiClassifier,deepseekVision}.js`, `adal-installer/`, `docs/data-protection.md`.

### 13. Measure the business, not just the PCs — S · Scale
- **Problem.** Business stats are behind `biz_stats` (off), and "hours saved" is a guess. Admin has no trial→paid funnel, churn risk score, time-to-first-value or ticket SLA.
- **Change.**
  - Turn `biz_stats` on everywhere (counts only).
  - Add a weekly owner dashboard: agencies in trial / paying / at risk (no profile in 7 days, robot success falling), MRR, renewals due in 30 days, median robot time per workflow vs measured human time, and tickets open more than 24 h.
- **Files.** `services/bizStats.js`, `adal-admin/{home,server}.mjs`, `public/index.html`.

### 14. CI and tests that guard what customers touch — M · Survival
- **Problem.** There is no CI. The frontend (~30k LOC) and Admin have 0 tests. 38 services have no test, among them `passportOcr`, `passportFace`, `autoTrigger`, `mainPC`, `musanedPreflight`, `tasheerSession`, `worker.js` and `routes/automations.js`. The suite is flaky on release commits.
- **Change.**
  - GitHub Actions on every push: `npm test` + `go test ./...` + `vite build` on **windows-latest** (most of your bugs are Windows-only).
  - Quarantine flaky tests instead of `--skip-tests`.
  - Add a smoke test that boots the server on a scratch DB and walks passport → profile → CV.
  - Run the button sweep (`scripts/button-sweep.mjs`) in CI.
- **Files.** `.github/workflows/ci.yml` (new), `adal-keep-backend/scripts/run-tests.mjs`, `tests/`.

### 15. Cut the flags from 157 to ~25 — S · Speed of development
- **Problem.** There are 157 distinct `ADAL_*` names, 56 of them used only once. Some features have three kill switches (`ADAL_COMPANION_FULL` / `ADAL_FULL_COPY` / `ADAL_AUTO_MAIN`). There are two flag systems (env/`flags.json` and agency config). Nobody, human or Claude, can reason about which combination a customer runs.
- **Change.**
  - Every feature that is released: delete its flag.
  - Every feature not released within 14 days: delete the code, or park it on a branch.
  - Keep one flag system: the signed agency config, with env only for developer overrides.
  - Publish a single generated `docs/flags.md`.
- **Files.** repo-wide; start with `services/agencyConfig.js`, `services/flags*`, `main.js`.

### 16. Hide what agencies don't need — S · Customers
- **Problem.** The sidebar and Settings carry developer and support tools: `/chat` (a 978-line chat between *all agencies*, a moderation and privacy risk), `/office`, Share-power, Rollback, USB, Telegram channel, the tutor tour, `/checklist`. They confuse staff and increase the surface.
- **Change.**
  - Hide `/chat`'s agency-to-agency part (keep Adal ↔ agency support chat, or fold it into Help tickets).
  - Move Office, Rollback, USB, Share-power and Telegram cards into an "Adal support" section visible only under the tower or with a support PIN.
  - The Dashboard (82 lines) should become the owner's morning view: workers per stage, stuck more than N days, robot runs today, codes waiting.
- **Files.** `components/layout/Sidebar.jsx`, `pages/{SettingsPage,DashboardPage,ChatPage}.jsx`.

### 17. Languages: Amharic first, properly — M · Customers
- **Problem.** Translation swaps phrases in the DOM (`lib/i18n.js` MutationObserver) from thin dictionaries (`labels.js` 76 lines, `ar-from-english.js` 62). Source strings mix Amharic and English, missing phrases show untranslated, switching reloads the page, and onboarding is English only. The clerks who type all day are more comfortable in Amharic.
- **Change.** Move to keyed strings (`t('profile.save')`) with complete Amharic and English files, have a native speaker review, and add Arabic later only for Saudi-side users.
- **Files.** `adal-keep-frontend/src/lib/i18n*`, pages.

### 18. Phone app distribution — S/M · Customers
- **Problem.** The APK is side-loaded (Play Protect warnings, "unknown sources") and an 11 MB APK is committed in git. The SMS-code forwarding (`SmsCodeReceiver.java`) is the killer feature, but Google Play restricts the `RECEIVE_SMS` permission.
- **Change.** Keep side-load for now but **host the APK on the website with a QR code**, not in git. Investigate Google's SMS User Consent / SMS Retriever API, or a notification-listener fallback, before a Play listing.
- **Files.** `adal-phone/`, `adal-keep-backend/src/phone-app/AdalKeep.apk` (remove from git).

### 19. Pin and update the bundled browser on a schedule — S · Survival
- **Problem.** Adal Browser is a pinned ungoogled-chromium 156 (`adal-launcher/browser.go:86-88`) that never receives security updates. It browses government sites with stored sessions.
- **Change.** Re-pin monthly as part of the release train. Updates already handle large pieces with delta patches.
- **Files.** `adal-launcher/browser.go`, `scripts/pack-browser.sh`.

### 20. Process: from CLAIMS.md to small, reviewed changes — S · Survival
- **Problem.** `docs/CLAIMS.md` is a hand-kept lock file with duplicates and a dozen "RELEASE PENDING" entries. Commits bundle about 15 features each. With 20 sessions this is how regressions such as the React #310 error, the double-connection bug and the `nul` file reach customers.
- **Change.**
  - **At most 3 writer sessions at once**, each on its own branch with a PR.
  - One "release captain" session merges, runs the Windows gate and publishes once a day.
  - Use GitHub Issues or a single `docs/ROADMAP.md` for claims.
  - Commit one feature per commit.
- **Files.** `docs/CLAIMS.md`, the workflow itself.

---

## 4. Delete / simplify list (do these; each one makes everything else easier)

| Delete or simplify | Why | Effort |
|---|---|---|
| Publish-on-push hook | Releases must be a decision (item 1) | S |
| `adal-companion/replica.go`, `standby.go` merge-back, launcher follower mode | Superseded by the full copy; 1,700+ lines of a second sync | M |
| Equal-PCs (`sync/{trust,authority,equal}.js`, `agency-trust.sql`, function) | Off, not deployed, a third trust system; park on a branch | S |
| GitHub update path in `routes/systemUpdate.js`; `ADAL_LAN_RELEASE_DIR` and the LAN-release leftovers | Dead since Supabase-only updates | S |
| One shared document channel for all agencies | Single point of failure (item 3) | M |
| Agency-to-agency chat (`ChatPage.jsx`) | Risk and moderation with no core value | S |
| Python in the backend (`agent.py`, `local_agent.py`, `webui.py`, `speedup.py`: 1,868 lines), `backend/`, `docker-compose.yml` (Postgres), `website-testing/`, `.tmpweb/`, root `index.html`, `Adal_website.html`, `TXT.txt`, `setup-ssh.bat`, `README.md` (describes Postgres + git pull) | Dead or misleading | S |
| `website/demo.html` mock-up, root `website/*.html` duplicates, `overview.html` EasyEnjaz promise, broken `adal-3d.html` links | One site, one demo (the real demo build) | S |
| Binaries in git: `AdalKeep.apk` (11 MB), `adal-companion/adal-companion` (9.6 MB ×3 in history), `adal-clip-3.exe`, traineddata (12 MB) | Release storage, not git | S |
| `notes-from-old-pc/`, `zadul-logo/`, `Adal-Keep-Pitch-Deck.pptx` in git | Private business material in a public repo | S |
| 56 one-use `ADAL_*` names, the 3-switch companion-full trio | Item 15 | S |
| Duplicate migration numbers (8 pairs) | Squash into a baseline at the next major release | M |
| `MAX_RUNS=1` comments about "v9 backoff" and other stale headers in `worker.js`, `subscription.js:11-14`, `plans.js:4-6` | They mislead the next Claude session | S |
| ~15 copies of `sleep()`, two `dumpPageState`, 9 copies of the dispatcher try/catch in `lmisWorkflow.js:2037-2163`, 4 copies of "ask for code, re-ask after 8 s" | One `robotKit.js` | M |

---

## 5. Recommendations for the two sessions already running

**Robot speed session** (do not duplicate; these are inputs):
1. **Measure first.** Save `activeMs` and per-step times into `run_history` (new columns), and print a per-workflow p50 and p90 table. Without this, every speed claim is a guess.
2. Musaned Add Candidate: replace the ~45–55 s of sleeps with DOM conditions (skills, dropdowns, fields, photo, modal settle, `toEnglish`). This is the single biggest win.
3. Diagnostics only on failure; buffer log writes.
4. Local screen check first, JEV only when the result is unknown; delete `reviewStageComplete`.
5. `Network.setBlockedURLs` instead of request interception; images only while a captcha shows.
6. A warm browser during office hours; prewarm the portal tab when a profile page opens on a step that will need it.
7. Resize the passport picture once at upload; cache the LMIS PDF by hash.
8. Wafid `sleep(20000)`, the Visa 4–5 s sleeps, LMIS 3 s sign-in confirmation and 30 ms per-character typing.
9. Read-only steps through the site's own data calls (`siteApi.js`), never for writes.
10. Keep "one run at a time per PC". Speed comes from no idle waits, not parallel tabs on a weak PC.

**Branch-linking session:** keep it to *one* mechanism that reuses the existing sync engine (a branch is a PC whose role is "branch", with a data filter), not a new path. Decide early what a branch can *see* (all workers or its own) and enforce it in the backend (`staffRoles`), not only in the UI. Licence and price per branch need the signed `{pcs}` licence from item 6. And don't ship it to the live agency before items 1, 2 and 5 are done.

---

## 6. Distribution: how this becomes a real company

- **Market.** Ethiopia has a large number of licensed private employment agencies sending workers to the Gulf, Saudi Arabia above all. The exact count of active licences is worth getting from the Ministry of Labour and Skills (MoLS) list. Every one of them touches Musaned, LMIS, Wafid and Enjaz for every worker, so the pain is universal and measurable per worker.
- **Pricing logic.** Sell per **worker processed**, framed per 6 months. At 49,999 ETB / 6 months, an agency processing 30 workers a month pays about 280 ETB per worker. Show "you save ~45 staff-minutes per worker" (measured, item 4) next to it. Keep one plan, as decided.
- **Channels, in order:**
  1. **Reference customer.** Nuzla, with a written quote and the stopwatch video.
  2. **The agency associations** (the Ethiopian overseas employment agencies' association): one demo at their meeting reaches dozens of owners. Offer an association discount.
  3. **Referral:** one free month for both sides per referred paying agency.
  4. **Agent and broker networks** that already visit agencies: 10% commission on the first payment.
  5. **The Saudi side:** recruitment offices in Saudi Arabia that pick workers from many Ethiopian agencies would love a clean, shared CV link. That is a later network effect (CV links that open in Adal Keep).
- **Sales motion that scales without the owner.** Website with price, video and a demo build → sign-up form → automatic download code → in-app checklist → one remote session (tower and control, not SSH) → training video in Amharic → paid by Chapa or telebirr. The owner's time goes only to the demo meeting.
- **Hire, in order:** (1) a support/onboarding person in Addis who speaks with agencies daily (Help tickets, training), (2) a part-time sales person on commission, (3) a second engineer once you pass ~20 agencies, owning Windows QA and releases.

---

## 7. A 30/60/90-day plan

- **Days 0–7 (stabilize).** Items 1, 5, 6 (price consistency), and the first steps of 2 and 3 from the private note. Pitch with the demo build and the stopwatch video. Rotate every shipped secret.
- **Days 8–30 (prove).** Items 2 and 3 complete, 4 (robot speed with measurement), 7 (self-serve onboarding), 9, 14 (CI on Windows), and the delete list in §4. Goal: **5 paying agencies, zero "it broke after an update" calls.**
- **Days 31–60 (sell).** Items 10, 11 (Main box offer), 12, 13, 16, 17. Association demo; referral program; Chapa or telebirr payments. Goal: 15–20 paying agencies; time-to-first-profile under 1 day without the owner.
- **Days 61–90 (scale).** Hire onboarding support; cloud-runner probe for Musaned; branch linking to multi-branch agencies; Saudi-side CV link. Goal: 40+ agencies, renewals above 80%.

**Numbers to watch every Monday:** paying agencies, trials, trial→paid %, MRR (ETB), renewals due, median robot time per workflow vs human, robot success %, tickets older than 24 h, releases shipped and rolled back.
