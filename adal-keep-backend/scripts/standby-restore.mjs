/**
 * standby-restore.mjs — an Adal Companion is about to stand in for its main PC
 * (adal-companion standby.go): its own copy of the agency (kept on this PC,
 * every piece locked) is opened into this server's data folder — the database
 * (put in place when the server starts) and every document.
 *
 *   ADAL_RESTORE_FROM      the Companion's copy, http://127.0.0.1:47810
 *   ADAL_RESTORE_NUMBER    the main PC's number (the copy checks it)
 *   ADAL_RESTORE_PASSWORD  the agency's backup key (never on the command line)
 *
 * Prints one line of JSON: { ok, files, database, made } or { ok: false, error }.
 */
const from = process.env.ADAL_RESTORE_FROM || 'http://127.0.0.1:47810'
const number = process.env.ADAL_RESTORE_NUMBER || ''
const password = process.env.ADAL_RESTORE_PASSWORD || ''
try {
  const { restoreFromCompanion } = await import('../src/services/telegramBackup.js')
  const r = await restoreFromCompanion(from, { number, password })
  console.log(JSON.stringify({ ok: true, ...r }))
  process.exit(0)
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }))
  process.exit(1)
}
