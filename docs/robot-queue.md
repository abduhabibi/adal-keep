# The robot queue — the contract for Adal Robots (2026-11-24)

Since this commit Adal Keep runs **no** robot machinery by default (`services/robotsInApp.js`):
no worker, no robot browser (no Adal Browser, nothing on port 9222), no sign-in keeper, no
scanner / agency manager / Wafid / contract checkers. A robot button only writes a job into the
queue below; a separate program, **Adal Robots**, runs the jobs. `ADAL_ROBOTS_IN_APP=1` on a PC
brings the old in-app robots back (then Adal Robots must not run on that PC).

## Where

The agency's SQLite database on the **main PC**:

- Main: `C:\AdalKeep\backend\data.sqlite` (`SQLITE_PATH` if set; this PC: `adal-keep-backend/data.sqlite`)
- A Companion's own copy: `C:\AdalKeepCompanion\server\backend\data\data.sqlite`. Companions do not run
  robots: their jobs reach the main PC with the rest of the data (`dispatchRun` → `on_main`).

Open it with a busy timeout (Adal Keep writes to it all the time): `PRAGMA busy_timeout=15000`.
Keep transactions short; never change its journal mode or schema.

## Table `automation_queue` (migrations 021, 025, 067)

| column | meaning |
|---|---|
| `id` | the run number (shown as "run #id") |
| `profile_id` | the profile (`profiles.id`) the run is for |
| `workflow_id` | what to do: `musaned_add`, `lmis_*`, `wafid_*`, `tasheer_*`, `insurance_certificate`, … (`src/services/workflows/`) |
| `account_id` | the site account to sign in with (`*_accounts` table of that site), or null for the default |
| `status` | `pending` → `running` → `done` / `failed` / `cancelled`; `paused` (waits for a person or another run) |
| `current_step` | the step index it reached (0 at the start) |
| `context` | JSON, **sealed** (`services/accountVault.js seal/open`; key `data/account-vault.key`): the account snapshot, `on_device`, `with_run`, … Never log it. |
| `log` | JSON array `[{ ts, level: info|warn|error, msg }]`, appended; the page shows it |
| `pause_reason` | why it waits: `In line for Adal Robots` (a button, robots not in the app), `Waiting for …` (a wait with `updated_at` as the time it may go on), `with-run-<id>` (a member waiting on run `<id>`), a person's step, or a stop note |
| `priority` | integer, higher first (Robot history → Waiting: move up/down) |
| `preferred_lane` | old, ignore |
| `started_at`, `finished_at`, `created_at`, `updated_at` | ISO times |

## Claiming a job (one runner at a time per job)

The same as `worker.js claimNextJob` / `readyJobsQuery`:

1. Ready = `status = 'pending'` and (`pause_reason` is null, or not a wait reason, or a wait whose
   `updated_at <= now`). `In line for Adal Robots` counts as ready.
2. Order: `priority DESC, id ASC`.
3. Claim atomically: `UPDATE automation_queue SET status='running', started_at=:now, updated_at=:now WHERE id=:id AND status='pending'`.
   Only when 1 row changed is the job yours; else take the next one.
4. Skip jobs whose `context.with_run` names another run (they follow that run).
5. Respect Adal support's hold (`services/tower.js` `towerHeld()`, Admin → Fleet → Suspend) and the licence lock (`isAppLocked()`), as `claimNextJob` does.

## While it works

- Append to `log` (read, push `{ts, level, msg}`, write back) and set `current_step`, `updated_at`.
- Waits for a person: `status='paused'`, `pause_reason` = what the person must do; back to
  `running` when done. A run nobody answers in 10 minutes is cancelled with a note (the 10-minute rule).
- Save / Submit on a government site stays a person's click.
- The page also reads `run_history` (migration 065): one row per run — `run_id`, `workflow_id`,
  `site`, `profile_id`, `account`, `pc`, `started_at`, `ended_at`, `duration_s`,
  `outcome` (`running|done|failed|cancelled|paused|stopped`), `reason`, `step`, `has_shot`;
  `run_history_shots(history_id, jpg)` for the stop picture. Write it like `worker.js` does.

## Finishing

- Done: `status='done', pause_reason=NULL, finished_at=:now, updated_at=:now` (+ the profile's
  own fields the workflow sets, exactly as `src/services/workflows/*` do).
- Failed: `status='failed', pause_reason=<why in words>, finished_at, updated_at`; a short `log` line.
- Cancelled (by a person, `POST /api/automations/:id/cancel`, which sets `status='cancelled'`):
  the runner must look at `status` before each step and stop when it is `cancelled`.
- Members (`with-run-<id>`, group certificates): settled with their run (`insuranceCertificate.settleMembers`).

## What Adal Keep still does with the queue

Shows it (Robot history, the profile's runs, Waiting with move up/down), lets a person queue,
cancel and re-prioritise runs, and syncs the table between PCs like any other table. It never
claims a job unless `ADAL_ROBOTS_IN_APP=1`.
