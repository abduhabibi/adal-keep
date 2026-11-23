# Every PC equal — design, migration, status

Status (2026-11-23): **on main, behind `ADAL_EQUAL_PCS`, OFF by default. Not
released, not for the pitch.** With the flag unset nothing below runs, and the
PCs work exactly as in [companion-full.md](companion-full.md).

Builds on companion-full (b482345): every PC already keeps a full copy and
copies with every other PC (LAN + the online relay), and the "main role" is
already a lease (`sync/roles.js`). What was missing: (1) a way for PCs to
recognise their own agency with no main PC to vouch for them, (2) one kind of
install, (3) no PC that every other PC depends on.

## How PCs recognise their agency (for the owner)

1. When Adal sets up an agency, Adal's cloud makes that agency a private "stamp" (a key). Only the cloud holds it.
2. When a new PC joins (it types the agency code, then someone says Yes on another office PC or in Admin), the cloud stamps an ID card for that PC: "this PC belongs to Adal Nuzla".
3. On the office network, PCs only call out a scrambled code for the agency, never its name or any data.
4. When two PCs meet, each shows its ID card and proves on the spot that it really holds it. A PC from another agency, or one with a fake or copied card, is turned away, and everything they send each other after that is locked.
5. If Admin cancels a PC's card, every PC that hears about it turns that PC away, even PCs with no internet (the news passes from PC to PC). The cards are kept on each PC, so the office keeps working offline.

## The pieces

| What | Where | Who holds the secret half |
|---|---|---|
| Adal's root key (Ed25519) | public half in every build: `trust.js ROOT_PUBS` | Adal's PC only: `~/.adal-keep/agency-root.jwk` — **never regenerate** (every agency's anchor would stop checking) |
| Agency key (Ed25519), one per agency | anchor = root signs `{agency_id, agency_pub}` | Adal's cloud (`agency_trust`, kind `agency`; service key only) |
| Device key (Ed25519), one per PC | in its certificate | that PC only: `backend/data/agency-trust.json` (0600) |
| Device certificate | agency key signs `{agency_id, pc_id, slot, name, device_pub, serial, issued_at, expires_at (400 days)}` | — (public, shown to every PC it meets) |
| Revoked list (CRL) | agency key signs `{version, revoked:[{pc_id, before}]}`; higher version wins | — |

Code: `adal-keep-backend/src/services/sync/trust.js` (checks, handshake,
sealing, the PC's store), `authority.js` (the cloud's logic + one door
`handle()` + a Supabase store), `equal.js` (wiring on a running PC + its own
pages), changes in `node.js`, `peers.js`, `roles.js`, `index.js`,
`routes/sync.js`, `networkGate.js` (one line). Cloud: `adal-admin/supabase/agency-trust.sql`
(table), `adal-admin/supabase/functions/agency-trust/` (function, **not deployed**),
Admin `/api/trust/*` in `adal-admin/server.mjs` (no buttons yet).

### Joining (no main PC needed)

1. New PC: `POST /api/sync/join-cloud {code}` → cloud `request` with its
   pc_id + device public key → a request id.
2. A Yes, either way:
   * any certified PC of the agency: `GET /api/sync/join-requests` (signed list
     of who asks), `POST /api/sync/join-approve {request_id}` — the Yes is
     signed with that PC's device key and checked by the cloud against its
     certificate and the revoked list; or
   * Admin: `POST /api/trust/approve`.
3. The cloud gives the slot (the last three digits of every id a PC makes): the
   one it had, else the next free one. Slots now come from the cloud, so two
   PCs never share one with or without a main PC.
4. New PC: `POST /api/sync/join-collect` (signed with its device key, so only
   it can pick the certificate up) → certificate kept → first copy from
   **whichever PC of the agency answers** (UDP with the agency tag, then sealed
   `/sync/join-keys` + `/sync/snapshot` in 4 MB pieces, sha256-checked) →
   restart on it (same staging as the old join; the old database kept beside).

### Meeting on the LAN

* UDP 45454 announces `agencyTag = sha256("adal-agency-id|"+agency_id)[0..16]`
  (strict: only that; during the move also the two old tags). A PC not on the
  list yet is listened to when its tag matches — it only becomes an address to
  *try*; the handshake decides.
* Handshake (`POST /api/sync/auth/hello`, `/prove`): both send anchor +
  certificate + a one-time X25519 key + nonce. Each checks the other's chain
  (root → agency → device), same agency, not expired, not revoked, and a
  signature by the device key over the whole transcript (both certificates'
  serials, both one-time keys, both nonces, the session id). Session key =
  HKDF(X25519 shared secret, transcript).
* Every sync call after that: `x-adal-session: sid.n`, body (or `x-adal-box`
  for GET) AES-256-GCM sealed with the method + path + n as associated data;
  the answer sealed under the same n the other way. Numbers are never accepted
  twice (window of 4096) — a recorded call cannot be replayed or moved to
  another path. Sessions last 30 min, in memory only.
* The PC is the one its certificate names: `reach()` ignores a `/hello` whose
  sealed session belongs to another pc_id.
* Each side hands the other its revoked list when the other's is older, in
  the handshake itself — so a revocation spreads PC to PC with no internet.

### Revoking

Admin `POST /api/trust/revoke {agency_id, pc_id}` → revoked list version +1.
PCs online fetch it every 10 min (`startTrustJobs`); every other PC gets it at
its next handshake with a PC that has it. On a newer list a PC: ends that
PC's sessions, refuses its handshakes, marks its `sync_pcs` row removed (so
its old key is refused too, and that row is copied on to every PC). The
revoked PC itself, if it hears the list, stops serving (`cutOff = removed`).
Rejoining later needs a new Yes and gives a new certificate (entries are
"`pc_id` before <time>", so the new one is valid).

Not covered by revocation (as before): the agency backup key and the vault key
a revoked PC once received are not rotated, and the data it already copied
stays on its disk. Revocation stops *future* access.

### The main role = an automatic lease to the strongest PC on

`roles.autoStepEqual` (used instead of `autoStep` when the flag is on):

* Each PC writes its power once (`sync_role` row `power:<pc_id>`, copied):
  2 per core + 1 per GB of memory (the 2-core 4 GB A4 = 8, a 4-core 16 GB PC = 24).
* Lease run out (15 min unseen): the strongest PC alive takes it (`strongest`).
* A PC holding it by itself hands it to a PC on the network ≥ 1.5× stronger
  once no run is going (≤ 10 min wait, as before) (`stronger`) — this takes the
  robots and scheduled jobs off the weak A4 that was the bottleneck today.
* A role a person took or handed over is never moved by itself.
* Two PCs apart from each other may both take it; when they meet, the newer
  stamp wins (unchanged).

## Flags

| `ADAL_EQUAL_PCS` | Meaning |
|---|---|
| unset / `0` | today's behaviour, nothing new runs |
| `1` | moving over: certificates used where both PCs have one; a PC without one (older version, not enrolled yet) still copies with its key; both old LAN tags still announced |
| `strict` | target: certificates only; the key alone is refused on `/api/sync/*`; only the agency tag is announced |

`ADAL_TRUST_ROOT_PUB` adds root public keys (tests only). `ADAL_PC_POWER`
overrides the measured power (tests). `ADAL_TRUST_CLOUD` points a PC at
another cloud door (tests).

## Migration (existing agencies) — nothing typed, nothing lost

The data does not move at all: identity is added *next to* the existing copy.

0. **Cloud, once** (Adal): run `adal-admin/supabase/agency-trust.sql`;
   `node adal-admin/supabase/functions/agency-trust/copy-shared.mjs` then
   `supabase functions deploy agency-trust --no-verify-jwt`.
1. **Per agency, once** (Admin): `POST /api/trust/create {agency_id, code: <the agency's PC number>}`.
2. **Release with the flag `1`** to that agency only (staged, `early.json`). Every
   PC keeps copying with its key as before.
3. **First PC enrols**: the PC holding the main role asks (`join-cloud` with its
   existing slot), Admin says Yes, it collects. It then writes every slot in its
   `sync_pcs` to the cloud (`reserveSlots`) so no new PC can be given one in use.
4. **Every other PC enrols by itself**: `join-cloud` asks the cloud, then calls
   a certified PC's `/sync/vouch` *with its existing key*; that PC checks the
   key belongs to the very pc_id of the request and signs the Yes. No click.
   The certificate keeps the slot it had. From its restart on, the two copy
   sealed (`reach()` switches as soon as the other's `/hello` says it has a
   certificate).
5. **All PCs certified** → release with `strict` to that agency. Keys are no
   longer accepted between PCs (phones/web access through `pc-access` are not
   touched by this).
6. **One installer**: once every agency is strict, the Companion installer and
   `companion-install` marker become unnecessary — every install is "Adal Keep";
   a fresh PC with no certificate shows the join screen (agency code → wait for
   a Yes). `isCompanionInstall()` stays only for installs made before.
   **Not done yet** — see below.

Rollback at any step: unset the flag (or ship the release before). The
certificate file is ignored; keys were never removed in `1` mode, so copying
goes on with keys. After `strict`, going back to `1` is safe the same way.

## Tests

* `tests/syncTrust.test.js` — chain checks (other agency, made-up root, edited
  certificate), Yes only by the agency's own PCs, certificate collected only by
  the asking PC, Admin-only ops; handshake + sealing (nothing readable on the
  wire, replay refused, moved call refused, copied certificate refused, a weak
  one-time key refused); the revoked list from cloud → A → B (offline); rejoin.
* `tests/syncTrustSim.test.js` — **3 PCs + intruders over real HTTP**, strict:
  A (Admin's Yes), B (A's Yes, first copy from A), C (B's Yes, first copy from
  B); edits on all three meet; key-only call refused; intruders refused: a real
  PC of another agency, a made-up "Adal Nuzla", B's copied certificate with
  another key, a replayed sealed call, a fake LAN announcement with the agency's
  tag; role A → B (3× stronger) → C after B is off a full lease; C revoked: cut
  off by A at once, by B offline (from A's hello); with the cloud gone A and B
  still recognise each other and copy.
* `tests/syncTrustMigrate.test.js` — two PCs joined the old way move over in
  `1` mode: mixed copying, `/vouch` with the old key (and refused for another
  PC's request), slots kept, a new PC gets the next free slot.
* All earlier sync and gate tests unchanged and green with the flag off.

## Not done / open (before this can ship)

* **No screens yet**: the join screen (agency code, waiting for a Yes), "PCs
  asking to join" with Yes/No on every PC, and Admin's buttons (create /
  approve / devices / revoke) — the routes exist, the pages do not.
* **The cloud function is not deployed and has never run in Deno**; the SQL is
  not run. `SupabaseTrustStore` is untested against real Supabase.
* **One installer** (step 6) is a plan: the NSIS installer and the Go
  launcher/Companion still have their two modes. The backend already treats
  "main" purely as a role; the Go side (`adal-companion/full.go`, `standby.go`,
  launcher `employee.go`) still decides by install kind.
* Never run on Windows or on the agency's PCs; only the simulations above on Linux.
* `pending` lists requests to any certified PC of the agency — a revoked PC is
  refused (the cloud checks its list), but a PC the agency only *suspended*
  (sync_pcs, not the cloud) could still see them.
* Session keys are per process; a restart means a new handshake (cheap: two calls).
