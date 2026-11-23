#!/usr/bin/env node
/** Adal's PC only: open an agency's sealed backup key.   node scripts/unseal-backup-key.mjs <key_sealed> */
import { unseal, loadPrivate } from '../src/services/backupSeal.js'
const s = process.argv[2]
if (!s) { console.error('usage: unseal-backup-key.mjs <key_sealed>'); process.exit(2) }
console.log(unseal(s, loadPrivate()))
