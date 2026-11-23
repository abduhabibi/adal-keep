---
name: pc-move
description: The user moved Adal Keep off the Zorin PC on 2026-11-05 with an encrypted bundle on the USB
metadata:
  type: project
---
On 2026-11-05 the user said they will stop using this PC. `adal-installer/move/pack-move.mjs` packed the project, git history, database, documents, WhatsApp, .env, ~/.adal-keep signing keys and these notes into `Adal Keep Move/` on the USB: AES-256-GCM parts, unlocked with `restore-adal.mjs` and a passphrase that is not on the USB.

**Why:** update-signing.pem and phone-release.jks cannot be regenerated, and whoever holds the signing key could sign updates for every agency PC, so the bundle must stay encrypted.

**How to apply:** re-pack only with the server stopped. Secrets now use the vault key ("v2:" in secrets.enc), so they survive a machine change. After restoring, the new PC needs its own licence unlock and phone pairing. Linux-specific notes in [[linux-app]] and [[pixel8-emulator]] apply to the old PC. See [[account-vault]].
