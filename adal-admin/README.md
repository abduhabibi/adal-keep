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

- **Work** — every agency live: PC on/off, profiles, chosen, runs waiting for
  a person, failures this week, open tasks, medicals running out, where the
  profiles stand. Pick an agency: **Continue** / **Cancel** its runs, mark its
  tasks done, give it a task (works while that agency's PC is on — the relay).
- **Open Adal Keep** — that agency's whole Adal Keep in its own window (port
  4101), exactly as the agency sees it: profiles, documents, runs and their
  live tabs, tasks. PC on: everything happens on its PC at once; PC off: its
  online copy, and changes wait for the PC. Shown to the agency as "Adal support".
  (Needs `adal-keep-frontend` next to this folder: start-admin.sh rebuilds those
  pages with `npm run build:admin` when they changed.)
- **Inboxes** — every agency's chat with you; answer, send pictures.
- **All chats** — the Everyone group and every private chat; delete messages.
- **Payments** — receipts sent from the lock screen. **Approve** unlocks that PC
  by itself within a minute; **Reject** tells the agency why.
- **Agencies** — name, PC number, today's unlock code, last seen; **Ban** /
  **Unban** (a banned agency can only write to you).

## Moving off Supabase later

Only two files talk to Supabase: `adal-keep-backend/src/services/chatCloud.js`
and `adal-admin/server.mjs`. The pages and the rest of Adal Keep stay the same.
