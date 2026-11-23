# Updates v2 (2026-11-23)

Small updates, the office first, staged, and undone by themselves when they break a PC.
Everything below is optional in the signed manifest: a PC that does not know a field
ignores it and works as before (the full `.tar.gz` and full programs stay in every release).

## 1. Delta pieces

A *piece* is one file of a release, known by its SHA-256 (the app `.tar.gz`, each program,
the Companion's pages `.tar.gz`). New, signed, inside the manifest:

```jsonc
{
  "file": "release/<sha>.tar.gz", "sha256": "<gz>", "size": 17400000,
  // the app as a plain .tar (what a patch rebuilds exactly; tar -xf reads both)
  "app_delta": {
    "raw":   { "sha256": "<tar>", "size": 41000000 },
    "patch": { "from": "<raw sha256 of the release before>", "from_gz": "<its .tar.gz sha256>",
               "file": "release/patches/<to>-from-<from12>.adalpatch", "sha256": "<patch>", "size": 90000 }
  },
  "app_files": { "adal-keep-backend/server.js": "<sha256>", "...": "..." },   // per-file, content-addressed
  "programs": [{ "name": "AdalKeep.exe", "file": "programs/<sha>-AdalKeep.exe", "sha256": "<exe>", "size": 9400000,
                 "patch": { "from": "<exe sha256 of the release before>", "file": "programs/patches/<to>-from-<from12>.adalpatch", "sha256": "…", "size": 12000 } }],
  "online": { "file": "online/<gz>.tar.gz", "sha256": "<gz>", "size": 7300000,
              "raw": { "sha256": "<tar>", "size": 13000000 },
              "patch": { "from": "<raw>", "from_gz": "<gz>", "file": "online/patches/….adalpatch", "sha256": "…", "size": 30000 } }
}
```

Patch format (`bsdiff.js`, `adal-companion/bspatch.go`): `"ADALDIF1"`, then little-endian int64
newSize, ctrlGzLen, diffGzLen, then three gzip streams: ctrl (int64 triples add, copy, seek),
diff bytes (added to old bytes mod 256), extra bytes. The result is always checked against
the signed SHA-256 (`raw.sha256` or the program's `sha256`).

How a PC gets piece P (`lanRelease.fetchPiece`, `selfupdate.go getPiece`):

1. here already: `files/<P.sha256>` or `files/<P.raw.sha256>`;
2. the patch: base = `files/<patch.from>`, or `files/<patch.from_gz>` un-gzipped, or (programs) the
   installed program whose SHA-256 is `patch.from`; the patch itself from a PC of the office, else Supabase;
3. the whole piece from a PC of the office (`raw` first, then the `.tar.gz`), else Supabase (the `.tar.gz`).

`GET /lan/file/<sha>` serves every form the signed manifest names (gz, raw, patch).
A release counts as complete here when every piece is here in one form (gz or raw).

## 2. LAN first

The main PC downloads; a Companion that can reach its main PC gives it a head start
(`ADAL_LAN_HEAD_START`, default 20 min from the first time it saw the release) before it goes to
Supabase itself, and takes pieces from the office meanwhile.

## 3. Staged rollout (only with `publish-update.mjs --staged`; by default every PC at once)

```jsonc
"rollout": { "test": ["<agency id>"], "pct": 10, "pct_at": "<ISO>", "everyone_at": "<ISO>", "stopped": false }
```

An agency takes the release from Supabase when: not `stopped`, and (in `test`, or now ≥ `everyone_at`,
or now ≥ `pct_at` and bucket(sha, agency) < `pct`). bucket = first 4 bytes (big-endian) of
SHA-256(`adal-rollout|<release sha>|<agency id>`) mod 100; unknown agency = 99.
`early` and `everyone_at` stay in the manifest for older PCs (early = test; stopped → everyone_at = 9999).
Adal Keep Admin → Updates: Advance (the next stage now) / Stop / Resume re-sign `latest.json` (same sha).

## 4. Auto-undo

After an update the main PC is on probation (`data/update-probation.json`, 30 min). It goes back by
itself to the signed way back (`manifest.rollback`) when: the self-check fails (files vs `app_files`,
core packages load, the database opens, the server answers), it crashed 3 times, or it logged ≥ 20
errors. The bad sha is blocked here (`data/update-blocked.json`) and reported online (`/_diag` → `autoUndo`).
Admin shows "rolled back on <PC>: <reason>" and the owner assigns: retry, keep on the old version,
or push to everyone — a signed `release/assign.json` the PCs read at each check.

## 5. 32-bit Windows

`programs` = amd64 (as before); `programs_x86` = GOARCH=386 builds with the same names.
A PC on 32-bit Windows (`PROCESSOR_ARCHITECTURE=x86` and no `PROCESSOR_ARCHITEW6432`) uses
`programs_x86`. The app itself is plain JavaScript; Node and Adal Browser come with the installer.
