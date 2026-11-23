---
name: account-vault
description: Portal passwords are encrypted in the database; data/account-vault.key must never be lost or regenerated
metadata:
  type: project
---
Since 2026-11-05 portal passwords (5 account tables) and automation_queue.context are stored as `enc:v1:` AES-256-GCM. Key: `adal-keep-backend/data/account-vault.key`, random per PC, git-ignored, excluded from installers, kept by updates and reinstalls. Telegram backups carry it in their locked index; restore stages it and swaps it with the database at next start.

**Why:** the user asked for encrypted passwords. Losing the key makes every saved password come back empty, with no recovery.

**How to apply:** never delete or regenerate the key. knexfile `postProcessResponse: openRows` opens every answer, including `db.raw`, so check stored values inside SQL. Writes use `seal()`; `sealStored` sweeps every 60s and rebuilds the file (VACUUM) when it seals something, because SQLite keeps old text in unused space. To verify, scan the file bytes and print counts only, never passwords. Don't leave a plaintext DB copy behind after a migration. Rolling back to a version older than the vault would see locked text.
