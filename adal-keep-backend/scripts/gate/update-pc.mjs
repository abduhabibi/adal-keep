/**
 * One fake PC for the release gate's update step (scripts/release-gate.mjs): the
 * real lanRelease.js (the release kept on a PC; its own ADAL_LAN_RELEASE_DIR —
 * the module reads it once at import, hence one process per PC). Since
 * 2026-11-23 every PC updates only from Supabase: the pieces the gate hands in
 * stand for what Supabase would have sent; nothing goes between PCs.
 *
 * The gate's throw-away PUBLIC key comes as the first line on stdin and is
 * set in this process with updateChannel._setVerifyKeyForTests — never from
 * the environment, a file or the network. Then one JSON command per stdin
 * line, one JSON answer per stdout line:
 *   {op:'install', env, pieces:[{sha256, path}]}   a release installed here (recordInstalled)
 *   {op:'patch', env, pieces:[{sha256, path}]}     the next release, given only its patch: every
 *                       piece made here (fetchPiece, cloud:false — kept, or rebuilt from the patch),
 *                       checked against the signed SHA-256, then installed here
 *   {op:'state'}       what is kept here
 * No network at all.
 */
import fs from 'fs'
import path from 'path'
import readline from 'readline'

const DIR = process.env.ADAL_LAN_RELEASE_DIR
if (!DIR) { console.error('update-pc: missing ADAL_LAN_RELEASE_DIR'); process.exit(2) }
process.env.ADAL_SYNC_ID = path.join(DIR, 'sync-id.json')

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const lines = readline.createInterface({ input: process.stdin })
const it = lines[Symbol.asyncIterator]()
const first = await it.next()
const pub = JSON.parse(first.value || '{}').pub
if (!/BEGIN PUBLIC KEY/.test(pub || '')) { out({ error: 'no public key' }); process.exit(2) }

const UC = await import('../../src/services/updateChannel.js')
UC._setVerifyKeyForTests(pub)
const L = await import('../../src/services/lanRelease.js')
// (lanRelease logs each piece it rebuilds: kept for the gate's note, not printed on stdout.)
const logs = []
console.log = (...a) => { logs.push(a.join(' ')) }
console.warn = (...a) => { logs.push(a.join(' ')) }

async function handle(c) {
  if (c.op === 'install') {
    for (const p of c.pieces || []) if (!(await L.keepPiece(p.sha256, p.path))) throw new Error(`piece ${p.sha256.slice(0, 12)} does not match`)
    if (!(await L.recordInstalled(c.env))) throw new Error('not signed: not kept')
    return { ok: true, complete: L.completeHere(c.env.manifest) }
  }
  if (c.op === 'patch') {
    const t0 = Date.now()
    if (!UC.verifyManifest(c.env?.manifest, c.env?.signature)) throw new Error('not signed: not installed')
    for (const p of c.pieces || []) if (!(await L.keepPiece(p.sha256, p.path))) throw new Error(`piece ${p.sha256.slice(0, 12)} does not match`)
    const pieces = []
    logs.length = 0
    for (const piece of L.piecesOf(c.env.manifest)) {
      const file = await L.fetchPiece(c.env.manifest, piece, null, { cloud: false })
      const got = await UC.sha256File(file)
      if (got !== path.basename(file) || !L.formsOf(piece).includes(got)) throw new Error(`${piece.file}: SHA-256 ${got.slice(0, 12)} is not the signed one`)
      pieces.push({ file: piece.file, form: got === piece.sha256 ? 'whole' : got === piece.raw?.sha256 ? 'raw' : 'other', sha256: got, size: fs.statSync(file).size })
    }
    if (!(await L.recordInstalled(c.env))) throw new Error('not kept')
    return { ok: true, ms: Date.now() - t0, sha: c.env.manifest.sha, pieces, patched: logs.filter(l => /rebuilt from the version before/.test(l)), complete: L.completeHere(c.env.manifest) }
  }
  if (c.op === 'state') {
    const env = L.current()
    return { ok: true, sha: env?.manifest?.sha || null, have: env ? L.haveOf(env.manifest) : [], complete: env ? L.completeHere(env.manifest) : false }
  }
  throw new Error(`unknown op ${c.op}`)
}

out({ ready: true })
for (;;) {
  const n = await it.next()
  if (n.done) break
  if (!n.value.trim()) continue
  let c = {}
  try { c = JSON.parse(n.value); out({ id: c.id, ...(await handle(c)) }) } catch (e) { out({ id: c.id, ok: false, error: e.message }) }
}
process.exit(0)
