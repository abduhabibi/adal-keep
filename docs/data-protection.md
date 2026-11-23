# Data protection (for agencies and partners who ask)

What protects a candidate's passport and personal data in Adal Keep, and what it does not yet.

## Where the data is
- On the agency's own main PC (database + documents). Companions keep their own copy.
- In the agency's own folder in Adal's Supabase (online copy for phones, backups).
- Passwords of portal accounts are encrypted in the database (account vault, `data/account-vault.key`).

## Backups in the cloud
- Every backup piece is encrypted **on the PC before it leaves** (AES-256-GCM, key from scrypt) with a key made for that agency alone (`backup_password`). Telegram and Supabase hold only locked pieces.
- Until now the key was also stored beside the index in the agency's own Supabase row (`keep_meta /_backup`), so the cloud held the lock and the key. **`ADAL_BACKUP_SEAL=1`** (or `data/flags.json` `{"backup_seal": true}`) stores the key only *sealed* to Adal's recovery public key (X25519 + HKDF + AES-GCM, new ephemeral key each time; `services/backupSeal.js`). Adal opens it on Adal's own PC: `node adal-keep-backend/scripts/unseal-backup-key.mjs <key_sealed>` (private key `~/.adal-keep/backup-escrow.pem`; never regenerate it). A PC that has its own key restores as before; a brand-new PC then needs Adal to give the key (that is the price of sealing). Off by default.

## One agency can never read another's data (Supabase)
- `adal-admin/supabase/rls-hardening.sql` (run once, safe to repeat). Found and fixed one gap: the **chat** bucket could be read by any signed-in agency; now only the uploader, members of the conversation that carries the file, and Adal.
- `tests/rlsAudit.test.js` reads every `.sql` on every test run: each table has row level security on; no rule says `using (true)` or `to anon`; every rule names the agency (`keep_agency()`/`auth.uid()`) or a membership; every bucket is private and each bucket rule names the bucket and an agency folder; the audit table cannot be changed afterwards.
- `scripts/rls-live-check.mjs`: with two TEST agencies, agency A writes a row and a file and agency B must read none of it, write nothing in A's folder and list nothing (every table and bucket). Run it by hand against the real project after running the SQL.

## Candidate consent, export, erase, audit
- Profile form and profile page: "The candidate agreed to share her data for recruitment." (who recorded it and when; can be taken back).
- Profile page → **Download her data**: a .zip with her record (JSON: profile, fields, notes, tasks, robot history, who looked at her) and her documents, CVs and photos. Needs the "export and back up" permission.
- Profile page → **Erase her data**: for good, her full name must be typed; her rows, documents, pictures, CVs and robot history go (not into the Trash); the audit log keeps only her id and "erased". Needs the "delete profiles" permission. *Not reached:* older locked backup copies (Telegram / online) roll over by themselves; the online copy in Supabase follows the normal sync.
- **Audit log** (Settings → Backup & updates; needs "manage staff"): who viewed a profile, downloaded a document, exported or erased, with the PC. The same person looking at the same thing again within 10 minutes is one line. Kept on the main PC (`audit_log`, migration 066). `keep_audit` (Supabase) is ready in `rls-hardening.sql` for a cloud copy; not wired yet.

## Not done yet (honest list)
- Documents in the online "keep" bucket are not encrypted client-side (phones and the online copy open them directly); isolation is by per-agency folder and RLS.
- `/uploads` (static documents folder) is served by the PC without a staff sign-in; who reaches the PC at all is the PC access gate (other computers need a Yes on the main PC).
- The audit log is on the main PC only.
