# Adal Keep — admin panel and chat server

The chat between agencies runs on Supabase (free tier). This folder is only
for Adal: the database setup and the admin panel. Agencies never get it.

## 1. Make the Supabase project (once)

1. supabase.com → New project (any name, e.g. `adal-keep-chat`; pick the region closest to Ethiopia).
2. **SQL Editor** → New query → paste all of `supabase/schema.sql` → **Run**.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Confirm email"
   (every Adal Keep PC makes its own account; nobody reads those e-mails).
4. **Project Settings → API**: copy the **Project URL**, the **anon public** key
   and the **service_role** key.

## 2. Every Adal Keep (agencies)

Add to `adal-keep-backend/.env` (it travels to every PC with the installer):

    SUPABASE_URL=https://xxxx.supabase.co
    SUPABASE_ANON_KEY=<anon public key>

The anon key is meant to be public: the database rules decide what each agency
may read or send.

## 3. The admin panel (only on Adal's PC)

Make `adal-admin/.env` (never shared, never committed):

    SUPABASE_URL=https://xxxx.supabase.co
    SUPABASE_SERVICE_KEY=<service_role key>
    ADAL_LICENSE_KEY=<the same as in adal-keep-backend/.env>

Open it: **Adal Keep Admin** in the app menu (or double-click
`start-admin.sh`) — its own window (Brave/Chrome app window with its own
profile, no browser bar); it starts the panel when it is not running. The first time, it asks you to choose your password;
after that it asks for it (12 hours per sign-in). Forgot it? Delete the
`ADMIN_PASSWORD_HASH=` line in `.env`, restart the panel and choose a new one.
By hand: `node server.mjs` in this folder.

It keeps running by itself: "Adal Keep Admin (keep running)" in the Windows
Startup folder runs `start-admin.vbs /keep` at sign-in, which starts the panel
again within 10 seconds whenever it stops (opening the window starts it too).
What it did is in `launcher.log`.

- **Work** — **Needs you** at the top lists what deserves a look first. Every agency live: PC on/off, profiles, chosen, runs waiting for
  a person, failures this week, open tasks, medicals running out, where the
  profiles stand. Pick an agency: **Continue** / **Cancel** its runs, mark its
  tasks done, give it a task (works while that agency's PC is on — the relay).
- **Open Adal Keep** — that agency's whole Adal Keep in its own window (port
  4101), exactly as the agency sees it: profiles, documents, runs and their
  live tabs, tasks. PC on: everything happens on its PC at once; PC off: its
  online copy, and changes wait for the PC. Shown to the agency as "Adal support".
  (Needs `adal-keep-frontend` next to this folder: start-admin.sh rebuilds those
  pages with `npm run build:admin` when they changed.)
- **Fleet** — the control tower, over the internet (no SSH, no LAN). Every agency
  PC (main, branch, Companion) sends a beat each minute: agency, PC name, who is
  signed in, version, CPU cores / load / RAM, free disk, Wi-Fi or cable, robots
  working / waiting / paused, last error, crash reports. Green = all fine; amber =
  something to look at (low disk or RAM, high load, weak internet, a crash in the
  last hour, robots suspended, late beat); red = no beat for 10 minutes. Filter by
  light, version, or type an agency / PC / employee. Click a PC for its commands:
  **Restart Adal Keep**, **Cancel all robot runs**, **Collect logs** (passwords,
  keys, passport and phone numbers hidden; opens here), **Run a self-check**,
  **Update now**, **Suspend / Resume robots** (no new run starts there), **Support
  note** (shows on the PC under Notifications, from "Adal support"). The PC does
  it within ~20 s when it is on (a command waits up to 24 h); each answer is listed
  under the PC. **Crash reports**: errors of the backend, the pages (React error
  boundaries, e.g. #310) and the Go programs, grouped by message, with counts per
  agency and version.
  - Each command is signed with Adal's tower key `~/.adal-keep/tower-signing.pem`
    (Ed25519; never commit it, never make a new one: its public half is in every PC,
    `adal-keep-backend/src/services/tower.js`). A PC runs only a command signed by
    it, for its own account, before it expires, once. Nothing new in Supabase: the
    PC's own `keep_meta` rows `/_tower/beat|cmds|acks|flag` and the private `keep` bucket.
  - Behind a flag: on only for the **Test agency** until you press **Open the tower
    for an agency…** (a number, `all`, or `close N`). `ADAL_TOWER=0` on a PC turns it off there.
- **Agents** — every foreign agent any agency works with, name and number, and
  every CV template. Drag one onto an agency (or click it, then the agency): it
  goes to that PC with its CV templates, without the header pictures. **Agents N of …**
  is the agency's plan: type a bigger number when its offer grows; empty means any
  number. Agents added by hand stay in `agents.json`. The agency's PC must be on.
- **CEOs** — agency, CEO and number, from each agency's setup. Type a missing
  one there: it stays in `ceos.json` and goes to the agency's PC when it is on.
- **Inboxes** — every agency's chat with you; answer, send pictures.
- **All chats** — the Everyone group and every private chat; delete messages.
- **Payments** — receipts sent from the lock screen. **Approve** unlocks that PC
  by itself within a minute; **Reject** tells the agency why.
- **Agencies** — name, PC number, today's unlock code, last seen; **Ban** /
  **Unban** (a banned agency can only write to you).

## Moving off Supabase later

Only two files talk to Supabase: `adal-keep-backend/src/services/chatCloud.js`
and `adal-admin/server.mjs`. The pages and the rest of Adal Keep stay the same.
