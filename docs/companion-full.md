# Companion with its own full copy ("main is only a name")

Branch `companion-full`. Status: built and tested on scratch data, **not published**.

## What the user asked

> Make the Adal Companion able to do the CV without sending it anywhere, just like
> the main one; then it sends it later through anything. Download everything.
> Make "main" just a name, nothing more; make the structure the same.

So every Companion runs the same Adal Keep as the main PC — server, database and
documents on its own disk — and every action (CVs, previews, PDFs, passport
reading, edits, uploads) happens on that PC at once. The PCs keep each other's
data the same afterwards: over the office network first, through the online
copy when there is no office path. "Main PC" is a role: the one PC that runs the
robots, the hourly and daily checks, the backups, the online copy for phones and
the licence.

## The design

### 1. One program, one structure

* The Companion installer (`3 - Install Adal Companion.exe`) installs the same
  full Adal Keep as Main: Node runtime, backend, `node_modules`, Adal Browser,
  frontend (from the same `deps\` folder PREPARE fills). It writes a marker file
  `companion-install`, so the PC **joins** an agency instead of starting one.
* `AdalKeep.exe` sees `runtime\node.exe` and runs exactly like on Main: it keeps
  the local server running and opens `127.0.0.1:4000`. On a Companion install it
  does not register itself to start with Windows (the 2026-11-14 rule: Adal Keep
  opens only from its icon), so a Companion copies only while it is open.
* `data/main-pc.json` gets `"mode": "companion"` plus the main PC's address. A
  Companion is **not** a "follower" (the older kind that opens the main PC's
  page): `isFollower()` is false for it; `notMainPC()` is true for both.

### 2. Joining: the first copy

`POST /api/sync/join-agency {main_url, number}` on the Companion (the join screen
`pages/JoinAgency.jsx` shows when `/setup/status` says `state: 'join'`):

1. `/pc-access/number` on the main PC with its number → this PC's key (as before).
2. `/sync/join` on the main PC → a **slot** (1–999, see ids below) and the key's
   hash in `sync_pcs`, the agency's list of PCs every PC holds.
3. `/replica/keys` → the backup key, the vault key, the locked secrets.
4. `/replica/manifest` + `/replica/db/:snap/:i` → a consistent SQLite snapshot of
   the main PC, in locked 1 MB pieces (the same pieces the old "locked copy"
   used, services/replica.js). Staged as `data.sqlite.restored` (the PC's own
   database is kept as `data.sqlite.before-join-…`), vault key staged like a
   restore, then the server restarts and `applyRestoredDatabase()` swaps it in.
5. On start the engine sees the database came from another PC and **adopts** it:
   the log, vector and merges stay (they are the agency's); the other PC's own
   queues (`ingest_queue`, `downloads_state`, `cloud_sync`, its unstamped
   changes, its peer and document indexes) are cleared.
6. Documents come after, by the normal rounds, smallest first. The Companion is
   usable at once.

The old Go Companion's locked replica (`adal-companion/replica.go`) is not used
by a full install (it only runs where there is no `runtime\node.exe`).

### 3. The sync engine (`adal-keep-backend/src/services/sync/`)

| file | what |
|---|---|
| `engine.js` | change capture, log, vector, apply, merges, compaction |
| `hlc.js` | hybrid logical clock |
| `ids.js` | ids that never collide; the knex client (`SyncClient`) |
| `tables.js` | which tables are copied, which stay per PC |
| `docs.js` | documents by content (sha256), never overwritten |
| `node.js` | one PC in the copying: rounds, pushes, peers, join, suspension |
| `relay.js` | the online copy as a relay (locked pieces in Supabase Storage) |
| `roles.js` | the main role as a lease; the licence written by the holder |
| `bootstrap.js` | the join (above) |
| `index.js` | wiring in `main.js`, the role ↔ `main-pc.json`, routes |
| `routes/sync.js`, `routes/mainProxy.js` | the HTTP side |

**Capture.** SQLite triggers on every copied table write `(table, row id,
column, time)` into `sync_dirty` for each changed field (inserts: `*`, deletes:
`-`). Nothing in Adal Keep's code calls the engine; raw SQL is captured too.
While the engine applies remote changes, `sync_ctl.applying = 1` and the
triggers stay quiet (no echo).

**The log.** `stamp()` turns the notes into this PC's append-only log
`sync_log(origin, seq, tbl, rid, col, val, hlc)`: one entry per field with the
row's current value and a hybrid-logical-clock stamp
(`<16-digit ms>.<count>.<pc id>`, compared as strings). An insert is all its
fields plus `_alive = 1`; a delete is `_alive = 0` — a **tombstone**, kept. A
change made here after seeing another PC's always sorts after it; a clock far
ahead (more than 10 min) does not drag the others.

**Swapping.** Each PC has a vector `{origin: last seq it has}`. `POST
/sync/pull {vector}` answers every entry after it, of every origin the answering
PC knows — its own and those it got from others — oldest first per origin, at
most 2000 entries / ~8 MB a call (`more: true` → ask again), with
`complete[origin]` when all of an origin was sent. `POST /sync/push` is the same
the other way. So a change reaches every PC by any path: straight, through a
third PC, or through the online copy, days later. Entries are identified by
`(origin, seq)`: applying is **idempotent** and a cut-off round just resumes.

**Conflicts.** Per field, the newest stamp wins (`sync_clock` holds the winning
stamp of every field). Two PCs editing different fields of the same girl both
keep their change; the same field → the later edit, on every PC. Applying
always stamps this PC's pending changes first, so a fresh local edit is never
overwritten by an older remote one.

**Rows that must be one.** A UNIQUE index (the same passport made on two PCs,
the same setting key, the same day row …) would refuse the second row. Instead
the PC that hits it writes a `_merge` entry (union-find: every PC merges the
same rows, even one where the clash never shows): the **smallest id stays**,
fields merge (newest **non-empty** value of each, so a fresh empty row never
blanks real data), pointers (`profile_id`, `field_template_id`,
`profile_field_id`) are re-pointed to the row that stayed — her fields, files,
CVs, notes, days — child rows that then clash merge the same way, and the row
that went is kept as JSON in `sync_conflicts`. Entries for a merged-away id
later land on the row that stayed.

**Waiting.** An entry that cannot go in yet — an update before its insert (it
came by another path), a field this PC's version does not have yet, a table it
does not have yet — waits in `sync_pending` and is rebuilt **from the log**
once it can (after each apply, and at start after an update).

**Compaction.** Hourly, an entry is dropped when a newer entry for the same field
wins both ways (newer, and not emptier). The newest of every field, every
tombstone and every merge stay. A PC joining later from a trimmed log ends the
same (tested).

### 4. Ids that never collide

All tables use `INTEGER PRIMARY KEY AUTOINCREMENT`, and SQLite's "biggest + 1"
would give two PCs the same id. Every new row's id is now

    id = milliseconds now × 1000 + this PC's slot

(always bigger than this PC's previous one), made where knex compiles an insert
(`ids.js` `SyncClient`, set in `knexfile.js`). So:

* no two PCs make the same id (slots are unique, handed out by the main role);
* ids still grow with time, so `ORDER BY id DESC` ("newest first") still works
  across PCs;
* they are plain integers below 2^53 until the year 2255 — JavaScript numbers,
  SQLite INTEGER, the online copy's `bigint` columns — so **no table, URL,
  JSON field or file name had to change**, and nothing needs id mapping;
* old rows (1, 2, 3 …) keep their ids; an insert that names its id keeps it
  (Trash restore).

Audit of id assumptions (2026-11-19): every table has a one-column integer key
except `cloud_sync` (text, per PC), `tutor_prefs` (text, per PC) and
`feature_use` (composite, per PC). Ids are parsed with `Number()` / `\d+`
everywhere; nothing does bit arithmetic on them; the phones' temporary negative
ids (cloudSync) are only on the main role. `tasks.js /calls` polls `id > after`:
those rows are made by robots, i.e. on the main PC only, so they stay in order.
Only one raw `INSERT` exists (`feature_use`, per PC).

### 5. What is copied

Everything a person or a robot makes (profiles, fields, files, CVs and
templates, accounts — passwords as stored, locked with the agency's vault key —,
notes, tasks, runs asked for, checklists, settings, Trash, WhatsApp agents and
sends, companies/branches/users/notifications, verifications) plus the two
shared tables of the copying itself: `sync_pcs` (each PC: name, slot, key hash,
addresses, port, last seen, vector, version, suspended/removed) and `sync_role`.
Each PC's own: `ingest_queue`, `downloads_state`, `cloud_sync`, `feature_use`,
`license`, `tutor_*`, `activity_log`, the AI chat history, `knowledge_base`,
`updates`. A new table from a later version is copied by default.

### 6. Documents

Every document in `data/SafeStorage` is fingerprinted once (sha256, in
`sync_docs`, refreshed by size and time). Each round a PC compares the other
PC's list (cached by a hash of the list) and fetches what it lacks, smallest
first. The same content already here under another name is **copied locally,
not downloaded** (dedupe). What arrives is checked against its sha256 and linked
in only if the name is still free — a document is **never overwritten**. The
same name with another content is kept beside as `<name>.sync-<hash12><ext>` and
noted in `sync_conflicts`. (File names are `Date.now()_…`, so this should not
happen in practice.)

### 7. Paths: office network first, the online copy otherwise

* Each PC writes its office-network addresses and port in its own `sync_pcs` row.
* Every minute, and ~2.5 s after any local change, a PC syncs with each PC it can
  reach (`/sync/hello` to find it, then pull, push, documents).
* A PC that no office path reaches: through the online copy (`relay.js`). Each
  PC puts **its own** entries that some PC has not had yet (by that PC's last
  vector in `sync_pcs`) online as never-changing pieces
  `keep/<agency>/sync/<pc>/<from>-<to>.bin`, and the documents they name as
  `keep/<agency>/sync-docs/<sha256>`, all **locked with the agency's backup key**
  (AES-256-GCM): Supabase holds only locked bytes. Others read pieces after their
  vector, in order. The main PC uses the agency's account; a Companion uses the
  online account the main PC made for it at join (`/pc-access/online-copy`).
  With every PC on the office network nothing goes online.

### 8. The main role (`roles.js`)

* `sync_role 'main'` names the holder. Each PC's `sync_pcs.seen_at` is its
  heartbeat (every 3 min). The role is a **lease** on that heartbeat (15 min).
* The first PC (an agency's existing Adal Keep, at the first start of this
  version) takes the role; a Companion install never does until it joins.
* Only the holder runs: the robots (worker, scanner), the hourly selection check
  (it still hands its lease to the strongest PC as before — Companions answer
  `helloMain`), the Wafid daily check, the contract checker, backups to
  Telegram, the online copy for phones and the live channel, WhatsApp, medical
  and appointment reminders, "needs action", portal health, profile days,
  placement sweep, PC health, Adal's signed licence watch, discovery answers,
  admitting new PCs, phone pairing. Everything a person does runs on every PC.
* A run asked for on a Companion is a queue row: it is copied to the main PC,
  whose worker runs it. The run's live view, its "I'm not a robot" box, codes,
  pause/stop are proxied to the main PC (`routes/mainProxy.js`), like the chat.
* Moving the role: on the holder, "make it the main PC" next to another PC
  (Settings → The agency's PCs). On another PC, "Make this PC the main PC…":
  allowed when the holder has not been seen for 15 min; earlier only with a
  second "it is gone for good" confirmation (`force`). The new holder writes
  `sync_role`; when the old main PC hears it (newest stamp wins) it becomes a
  Companion and restarts (`reconcileRole`). `main-pc.json` and `companion.conf`
  follow the role.
* **The licence** lives with the role. The holder writes its licence state into
  `sync_role 'licence'`, signed with `ADAL_LICENSE_KEY` (HMAC; every build has
  the key). The other PCs follow it (`subscription.followAgencyLicence`): open
  while it is paid or in its trial, locked or "suspended" with it. Codes are
  typed on the main PC (they are for its PC number). A forged record (wrong
  signature) is ignored.

### 9. Security (unchanged rules, now on every PC)

* Joining still needs the main PC's number (5 or 6 digits); `/sync/join` only
  answers a computer let in that way, and only on the role holder.
* Every PC's network gate accepts another PC's key only if its hash is in
  `sync_pcs` and the PC is not suspended or removed (`networkGate.approvedPC`).
  Calls through the online link (`x-adal-cloud`) are refused on `/sync/*`.
* Suspending, allowing or removing a Companion in Settings → Connected devices
  is written into `sync_pcs`, so every PC refuses it. The suspended PC locks
  itself with the "suspended" screen as soon as another PC refuses it, keeps
  asking each round, and opens again by itself when allowed.
* The copying routes are mounted before the licence guard (a locked Companion
  must still hear it was paid for) and after the network gate.

## Tests (all on scratch folders; Supabase and Telegram off)

* `tests/syncEngine.test.js` — ids never collide and stay ordered; the same girl
  edited on two PCs while apart (every field kept, the same everywhere,
  idempotent); a delete beats older edits on 3 PCs; the same passport made on
  two PCs → one girl, both fields, both documents, the CV re-pointed, one day
  row, the same on a 4th PC joining later; one setting; a Companion starting
  from Main's file (old pre-sync rows, its own queue empty); 3 weeks apart with
  3,400 rows each way, trimmed log, a 3rd PC later; an update before its row.
* `tests/syncNodes.test.js` — three PCs, each an HTTP server on a spare port:
  edits anywhere; **a CV made on a Companion with Main off reaches Main (row and
  PDF) when Main is back**; documents fetched once (dedupe) and a clash kept
  beside; a PC only the online copy reaches (locked pieces, photo included);
  the main role refused while seen, taken when gone, the old Main steps down when
  it hears and gets it back by hand-over; the signed licence followed, a forged
  one ignored; suspension refused everywhere and lifted by itself.
* `tests/syncJoin.test.js` — the real join over HTTP through `routes/replica.js`:
  wrong number refused, slot 2, the key on the agency's list, the snapshot opens,
  both ways after.
* Smoke test of the real `main.js` (two scratch copies of the backend with no
  `.env`, own `HOME`, network and browser blocked): join by number, restart with
  the copy, edits both ways within ~4 s, the document copied, the licence
  followed, suspension locks the Companion.

## Migration (existing agencies)

1. Update Main first (release). At its first start it creates the sync tables
   and triggers, takes the main role (slot 1), and writes its licence record. Its
   data and ids are untouched; new rows get time ids.
2. Install the new Companion installer on each employee PC (a Companion program
   update cannot add the Node runtime: it needs the USB). The PC shows "Join your
   agency": the main PC's address (found on the network) and its number.
3. Older Companions (Go only) keep working against the updated Main as before
   (they open the main PC's page). Follower PCs (`main_url` without `mode`) are
   unchanged.

## Risks and open points

* **Not tested on Windows.** NSIS builds compile; the launcher cross-compiles.
  The installer, the restart after join (`process.exit(0)` + AdalKeep.exe) and
  file linking on NTFS need a real Windows run before publishing.
* **Disk and first copy.** Every Companion holds every document. A large agency
  (GBs) needs a long first download; it is smallest-first and resumable, and the
  PC works meanwhile, but a document not here yet does not open until it comes.
* **Companions copy only while open** (they do not start with Windows, the
  user's rule). A Companion closed for weeks catches up when opened (tested), but
  its changes reach the others only then. Consider allowing the hidden server at
  sign-in for Companions.
* **Two main PCs during a split.** If the office network splits and someone
  forces the role on the other side, both run robots until they meet; then the
  newer take wins. Forcing needs an explicit second confirmation.
* **Merged rows never go back to empty.** Inside a merged group (twins), a field
  cleared to empty loses against an older non-empty value. Only twins (UNIQUE
  clashes) are affected.
* **Merged twins' fields.** Two profiles merged keep all their `profile_fields`;
  two "Passport" fields may then show on her profile (nothing lost, a person
  tidies). A merge is listed in `sync_conflicts`; there is no UI for it yet
  beyond the count in Settings.
* **Migrations that insert rows** run on every PC: such rows would be made once
  per PC. Rule from now on: a migration that seeds data checks `notMainPC()`
  (the data then comes by the copying), or uses a fixed id.
* **Clock far off.** A PC whose clock is wrong by hours still syncs (nothing is
  refused or lost), but when two PCs change the same field, its wrong time
  decides which edit counts as the later one. Stamps more than 10 minutes in the
  future do not move the other PCs' clocks.
* **Passwords typed on a Companion** are in plain text in that PC's log for up
  to an hour (until `sealStored` locks them and compaction drops the plain
  entry); they travel over the office network inside the agency only.
* **The robots' live view on a Companion** needs the main PC reachable
  (proxied); with Main off a run simply waits in the queue.
* **Removal does not rotate keys.** A removed PC's key is refused everywhere,
  but the agency backup key it once had is not changed.
* **Logout on a Companion** stops its copying (refused as removed) but leaves its
  local copy on disk until it joins again (the new copy replaces it, the old one
  is kept beside).
* **The chat** on a Companion still goes through the main PC (as before).

## Still to do

* Windows end-to-end on two real PCs (USB build, join, restart, documents).
* A UI list of merges and documents kept beside (`/sync/conflicts` exists).
* The Companion's "Log out" button (old launcher flow) should call the main PC's
  `/pc-access/leave` from the backend for a full install.
* Rebase onto `no-downgrade` / `stay-signed-in` / `speed` / `stage-buttons` when
  they land (they touch `cloudSync.js`, `pcAccess.js`, `mainPC.js`).
