# Billing and the business dashboard (2026-11-23, flags off by default)

## Billing (flag `billing`: ADAL_FLAG_BILLING=1 or data/flags.json {"billing": true})
- Licence unchanged: 21-day trial, 30,000 ETB / 6 months, per-PC Authenticator code, ADAL_LICENSE_KEY untouched (a test checks billing.js never touches it).
- Admin → Billing: every agency's licence state, renewal date, last payments. "Payment received" (telebirr / bank / cash, reference, amount, date): adds 6 months per 30,000 ETB to the signed licence (from the end of what is paid, or today), which Admin nudges to every PC of the agency; records it in `adal-admin/billing-ledger.json` (this PC only, gitignored) and a signed copy for the agency (`adal-updates/billing/payments/<PC>.json`, its own payments only); tells the agency in its inbox. Same reference twice is refused. No card fields exist.
- Payment instructions (telebirr, banks, phone, note): edited in Admin → Billing, signed (`billing/instructions.json`), shown in the app on Billing (`/billing`), in the 7/3/1/12-hour reminder ("How to pay") and on the lock screen. Reminders themselves are the existing SafetyAlerts (in app only).
- Code: backend `services/billing.js`, `GET /api/subscription/billing` (open when locked), frontend `pages/BillingPage.jsx`, `components/PaymentInstructions.jsx`.

## Business dashboard (flag `biz_stats` on each agency's PC; Admin → Business always reads what exists)
- Each main PC sends counts only (`keep_meta /_stats`, every ~30 min): profiles added/day, CVs, stage moves/day (profile_days), average days per stage, per robot done/failed/seconds/day (run_history). No names, ids, accounts.
- Admin → Business: active agencies (heartbeat in 7 days), PCs on now (heartbeat `/_pc` < 60 s — the control-tower beat will refine this), profiles per day/week, stage moves, robot runs and success rate, time per stage, estimated staff hours saved (`MANUAL_MINUTES` in `services/bizStats.js`: edit the minutes there), revenue per month, MRR estimate, renewals due.
- Code: `services/bizStats.js`, one hook line in `cloudSync.js` (30-minute block), `adal-admin/server.mjs` (`/api/billing*`, `/api/business`), `public/index.html` (two tabs).

Tests: tests/billing.test.js, bizStats.test.js, adminBilling.test.js (Admin against a fake Supabase).
Release pending: turn `billing` / `biz_stats` on per agency (or the Adal Test agency first); no SQL to run.

## Pricing (2026-11-23, owner)
One plan, Premium, everything in it: 49,999 ETB / 6 months, 89,999 ETB / 12 months, 3 PCs included, extra PC add-on per 6 months (2,500 ETB default), 21-day full trial. Old basic/standard licences read as Premium. All prices are editable in Admin → Billing; optional USD-indexed mode (USD prices + today's rate → ETB shown in the app; payment stays ETB). The Authenticator code (subscription.js) still adds 6 months and is untouched.
Receipts: the app's Billing page uploads a screenshot (existing unlock_requests); Admin → Billing lists it with Confirm (term, extra PCs, amount prefilled) → signed licence extended for all PCs, receipt marked `confirmed:` so the PC does not add months again (routes/chat.js).
