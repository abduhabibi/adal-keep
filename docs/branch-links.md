# Branches — linking two agencies with a 6-digit code

Status (2026-11-23): on main, **release pending**, and the Supabase SQL is
**not run yet** (`adal-admin/supabase/branch-links.sql`). Until it runs,
Settings → Branches says "Branches are not on the online server yet" and
nothing else changes.

## No second password

Every agency has its own account (its PC signs in to Supabase by itself), so
there is no second password anywhere:

* **Removed: the agency's "phone password".** Phones used to be able to pair
  with the PC number plus a password the agency chose
  (`POST /api/mobile/phone-password`, `keep_set_phone_password`, `keep_join`
  with `p_password`, `keep_pairing.pass_hash`). Nothing in the app or the
  phone used it any more (phones pair with the PC number and a "Yes, it's me"
  on the PC), but the route and the functions were still live. Gone now: the
  route, `setPhonePassword`, the two Supabase functions (dropped by
  `branch-links.sql`, and no longer made by `keep-sync.sql`), and the stored
  hashes (cleared; the `keep_pairing` rows with the PC numbers stay).
  `GET /api/mobile/cloud` still returns `pairing` (PC number, updated time),
  without `pass_set`.
* Not touched (they are not a second agency password): staff passwords
  (each employee's own sign-in), the backup password (only for a self-run
  Telegram backup; Adal's shared backup needs none), portal sign-ins.

## The flow (for the owner)

1. Settings → **Branches** → type part of the branch's name. Only names and
   cities show (each agency types its city at the bottom of the same page).
2. Press **Connect**. The other agency gets a notification and a beep:
   *"<Agency> wants to link as your branch"*.
3. There, Settings → Branches → **Yes, it is me**. A 6-digit code shows. It
   works for 10 minutes and only once. "New code" makes another (the old one
   stops working).
4. They tell the sender the code (phone, in person). The sender types it and
   presses **Verify**. Linked, both ways, at once: both see **✓ Connected**
   with **Unlink**.

A wrong code says so; 5 wrong codes end the request (Connect again). An old
code says "older than 10 minutes"; a used one says "already used". At most
10 Connects an hour per agency and 5 codes per request. "No, not us" ends the
request.

## What linked agencies share (decided: the minimal set)

Each agency's PC already puts its profiles online every minute (the online
copy, `keep_profiles`). A linked branch reads **summaries** of them: name,
passport number, stage, status, nationality — never documents, photos,
portal passwords or anything else in the row. Each side can untick
"Share our profiles with them" at any time (default on, since both sides
agreed with the code). The PC pulls the branch's summaries every 5 minutes
(only what changed since the last pull) and Settings → Branches lists them.

Linked agencies stay separate agencies: their own data, PCs, robots,
licences. Nothing is copied into the other's database, so a link can never
mix two agencies' profiles or ids. A deeper sync (e.g. moving a profile to a
branch) can build on the same link later.

## Who sees what (Supabase, RLS)

| Table | Who can read | Who writes |
|---|---|---|
| `keep_branch_requests` | nobody directly (no policy) — only through the functions | the functions, Adal's service key |
| `keep_branch_links` | only its two agencies | the functions, Adal's service key |
| `agencies.city` | through `keep_branch_search` (name + city only) | `keep_set_city` (own row) |

The code is never stored, only `crypt(code)`, and only until it is used,
expires or fails. Phones (`keep_devices`) and banned agencies cannot call any
of it. Wrong tries are answered with a word, not an error, so the count is
really kept.

## Pieces

* Supabase: `adal-admin/supabase/branch-links.sql` (run after `schema.sql`
  and `keep-sync.sql`; safe to run again).
* PC: `adal-keep-backend/src/services/branchLinks.js`,
  `src/routes/branchLinks.js` (`/api/branch-links…`; changes need the
  "change settings" staff permission; a follower PC passes calls to the main
  PC), started in `main.js`.
* Page: `adal-keep-frontend/src/components/BranchLinksCard.jsx` (Settings →
  Branches tab).
* Admin: **Branches** tab — every link with both names and who shares,
  requests of the last 7 days (never codes), Unlink.
* Tests: `tests/branchLinksSql.test.js` (the SQL in a throw-away local
  Postgres: wrong code, expired, reuse, five wrong, new code replaces old,
  rate limits, No, unlink, RLS, profile summaries; skipped without Postgres),
  `tests/branchLinks.test.js` (the PC side against a fake Supabase).
