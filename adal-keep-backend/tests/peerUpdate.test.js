// A Companion newer than Main hands its signed release to Main (2026-11-27). A real HTTP server plays the
// Companion (adal-companion peerserve.go answers the same two routes); the install itself is applyLocalRelease's.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const { signManifest, _setVerifyKeyForTests } = await import('../src/services/updateChannel.js')
const P = await import('../src/services/peerUpdate.js')
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }), pub = publicKey.export({ type: 'spki', format: 'pem' })
const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
_setVerifyKeyForTests(pub)
process.env.ADAL_PEER_ANNOUNCE_MS = '0'
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

function companion() {
  const c = { files: new Map(), env: null, asked: 0 }
  c.offer = (m, key = priv) => { c.env = { manifest: m, signature: signManifest(m, key) } }
  c.server = http.createServer((req, res) => {
    c.asked++
    if (req.url === '/peer/release' && c.env) return res.end(JSON.stringify(c.env))
    const f = req.url.startsWith('/peer/file/') && c.files.get(req.url.slice(11))
    if (f) return res.end(f)
    res.statusCode = 404; res.end()
  })
  return new Promise(ok => c.server.listen(0, '127.0.0.1', () => { c.url = `http://127.0.0.1:${c.server.address().port}`; ok(c) }))
}
function release(c, shaHex, date, app = 'the app ' + shaHex) {
  const appB = Buffer.from(app), prog = Buffer.from('a program ' + shaHex)
  c.files.set(sha(appB), appB); c.files.set(sha(prog), prog)
  return { sha: shaHex, short: shaHex.slice(0, 7), date, file: 'app.tar.gz', sha256: sha(appB), size: appB.length, programs: [{ name: 'AdalKeep.exe', file: 'p', sha256: sha(prog), size: prog.length }] }
}
const MINE = { sha: 'a'.repeat(40), date: '2026-11-26T10:00:00Z' }

test('a newer signed release on a Companion: announced, then installed here with every piece checked', async (t) => {
  P._resetPeerForTests()
  const c = await companion(); t.after(() => c.server.close())
  c.offer(release(c, 'b'.repeat(40), '2026-11-27T10:00:00Z'))
  const notice = {}, got = []
  const deps = { peers: async () => [{ name: 'DESKTOP-RPFQ8LN', url: c.url }], mine: async () => MINE, busy: async () => false, notice,
    apply: async (dir) => { const cur = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')); got.push(cur.manifest.sha, ...fs.readdirSync(path.join(dir, 'files')).map(f => sha(fs.readFileSync(path.join(dir, 'files', f))) === f)); return { message: 'Update installed.' } } }
  assert.equal(await P.peerStep(deps), 'announced')
  assert.equal(notice.peer.from, 'DESKTOP-RPFQ8LN')
  assert.equal(await P.peerStep(deps), 'installed')
  assert.deepEqual(got, ['b'.repeat(40), true, true])
  assert.equal(notice.peer, null)
})

test('never: unsigned, another key, older or the same, while runs work, or off', async (t) => {
  P._resetPeerForTests()
  const c = await companion(); t.after(() => c.server.close())
  let applied = 0
  const deps = { peers: async () => [{ name: 'C', url: c.url }], mine: async () => MINE, busy: async () => false, notice: {}, apply: async () => { applied++; return {} } }
  c.offer(release(c, 'c'.repeat(40), '2026-11-27T10:00:00Z'), other)
  assert.equal(await P.peerStep(deps), null, 'another key')
  c.env.signature = ''
  assert.equal(await P.peerStep(deps), null, 'no signature')
  c.offer(release(c, 'd'.repeat(40), '2026-11-25T10:00:00Z'))
  assert.equal(await P.peerStep(deps), null, 'older')
  c.offer({ ...release(c, MINE.sha, MINE.date) })
  assert.equal(await P.peerStep(deps), null, 'the same')
  c.offer(release(c, 'e'.repeat(40), '2026-11-27T11:00:00Z'))
  const busy = { ...deps, busy: async () => true }
  assert.equal(await P.peerStep(busy), 'announced')
  assert.equal(await P.peerStep(busy), 'waiting')
  process.env.ADAL_PEER_UPDATES = '0'
  try { assert.equal(await P.peerStep(deps), null, 'off') } finally { delete process.env.ADAL_PEER_UPDATES }
  assert.equal(applied, 0)
})

test('a piece the Companion lacks or changed: nothing installed, not asked again for 30 minutes', async (t) => {
  P._resetPeerForTests()
  const c = await companion(); t.after(() => c.server.close())
  const m = release(c, 'f'.repeat(40), '2026-11-27T12:00:00Z')
  c.files.set(m.sha256, Buffer.from('other bytes'))
  c.offer(m)
  let applied = 0
  const deps = { peers: async () => [{ name: 'C', url: c.url }], mine: async () => MINE, busy: async () => false, notice: {}, apply: async () => { applied++; return {} } }
  assert.equal(await P.peerStep(deps), 'announced')
  assert.equal(await P.peerStep(deps), 'failed')
  assert.equal(await P.peerStep(deps), null)
  assert.equal(applied, 0)
})
