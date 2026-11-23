/**
 * One fake PC for the release gate's "update goes round the office" step
 * (scripts/release-gate.mjs): the real lanRelease.js (its own
 * ADAL_LAN_RELEASE_DIR — the module reads it once at import, hence one
 * process per PC) and its real routes on 127.0.0.1:<port>/api/system/update/lan.
 *
 * The gate's throw-away PUBLIC key comes as the first line on stdin and is
 * set in this process with updateChannel._setVerifyKeyForTests — never from
 * the environment, a file or the network. Then one JSON command per stdin
 * line, one JSON answer per stdout line:
 *   {op:'install', env, pieces:[{sha256, path}]}   a release installed here (recordInstalled)
 *   {op:'fetch'}       the newest release the other PCs have (newestFromPeers, office only),
 *                      every piece of it (fetchPiece, cloud:false), checked, then installed here
 *   {op:'state'}       what is kept here
 * No UDP (ADAL_LAN_UPDATES=0, startLan never called), no Supabase.
 */
import fs from 'fs'
import path from 'path'
import http from 'http'
import readline from 'readline'

const DIR = process.env.ADAL_LAN_RELEASE_DIR
const PORT = Number(process.env.GATE_PORT)
if (!DIR || !PORT) { console.error('lan-pc: missing ADAL_LAN_RELEASE_DIR / GATE_PORT'); process.exit(2) }
process.env.ADAL_LAN_UPDATES = '0'
process.env.ADAL_PC_ACCESS_FILE = path.join(DIR, 'pc-access.json')   // (knownBases reads the list of computers let in)
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
const { default: express } = await import('express')
// (lanRelease logs each piece it fetches: kept for the gate's note, not printed on stdout.)
const logs = []
console.log = (...a) => { logs.push(a.join(' ')) }
console.warn = (...a) => { logs.push(a.join(' ')) }

const app = express()
app.use(express.json())
const router = express.Router()
L.lanRoutes(router)
app.use('/api/system', router)
const server = http.createServer(app)
await new Promise((ok) => { server.once('error', (e) => { console.error(`port ${PORT} on 127.0.0.1: ${e.code === 'EADDRINUSE' ? 'already in use' : e.message}`); process.exit(3) }); server.listen(PORT, '127.0.0.1', ok) })

async function handle(c) {
  if (c.op === 'install') {
    for (const p of c.pieces || []) if (!(await L.keepPiece(p.sha256, p.path))) throw new Error(`piece ${p.sha256.slice(0, 12)} does not match`)
    if (!(await L.recordInstalled(c.env))) throw new Error('not signed: not kept')
    return { ok: true, complete: L.completeHere(c.env.manifest) }
  }
  if (c.op === 'fetch') {
    const t0 = Date.now()
    const before = L.current()?.manifest || null
    const best = await L.newestFromPeers(before)
    if (!best) throw new Error('no PC of the office offers a newer signed release')
    const pieces = []
    logs.length = 0
    for (const piece of L.piecesOf(best.manifest)) {
      const t = Date.now()
      const file = await L.fetchPiece(best.manifest, piece, null, { bases: [best.base], cloud: false })
      const kept = path.basename(file)
      const got = await UC.sha256File(file)
      if (got !== kept || !L.formsOf(piece).includes(got)) throw new Error(`${piece.file}: SHA-256 ${got.slice(0, 12)} is not the signed one`)
      pieces.push({ file: piece.file, form: got === piece.sha256 ? 'whole' : got === piece.raw?.sha256 ? 'raw' : 'other', sha256: got, ms: Date.now() - t, size: fs.statSync(file).size })
    }
    if (!(await L.recordInstalled({ manifest: best.manifest, signature: best.signature }))) throw new Error('the release fetched is not signed: not kept')
    return { ok: true, ms: Date.now() - t0, from: best.base, sha: best.manifest.sha, pieces, patched: logs.filter(l => /rebuilt from the version before/.test(l)), complete: L.completeHere(best.manifest) }
  }
  if (c.op === 'state') {
    const env = L.current()
    return { ok: true, sha: env?.manifest?.sha || null, have: env ? L.haveOf(env.manifest) : [], complete: env ? L.completeHere(env.manifest) : false }
  }
  throw new Error(`unknown op ${c.op}`)
}

out({ ready: PORT })
for (;;) {
  const n = await it.next()
  if (n.done) break
  if (!n.value.trim()) continue
  let c = {}
  try { c = JSON.parse(n.value); out({ id: c.id, ...(await handle(c)) }) } catch (e) { out({ id: c.id, ok: false, error: e.message }) }
}
server.closeAllConnections?.()
server.close()
process.exit(0)
