// A release seeded on one PC (manifest.audience, 2026-11-22): Supabase hands it only to the PCs it names;
// any PC of the office takes it from them, signed and newer as ever. And the trail of versions.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-seed-'))
process.env.ADAL_UPDATE_TRAIL = path.join(T, 'trail.json')
process.env.ADAL_LAN_RELEASE_DIR = path.join(T, 'rel')
process.env.ADAL_RELEASE_BASES = ''
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const U = await import('../src/services/updateChannel.js')
U._setVerifyKeyForTests(publicKey.export({ type: 'spki', format: 'pem' }))
const L = await import('../src/services/lanRelease.js')
const TR = await import('../src/services/updateTrail.js')

const manifest = (letter, seq, extra = {}) => ({
  channel: 'release', sha: letter.repeat(40), short: letter.repeat(7), seq, published_at: new Date(Date.UTC(2026, 10, 22, 8, seq)).toISOString(),
  date: new Date(Date.UTC(2026, 10, 22, 7)).toISOString(), everyone_at: new Date(Date.UTC(2026, 10, 22, 8, seq)).toISOString(), early: [],
  file: `release/${letter}.tar.gz`, sha256: 'a'.repeat(64), programs: [], ...extra,
})

test('an audience lets only the named PCs take it from Supabase (any case); no audience: everyone', () => {
  assert.equal(U.audienceAllows(manifest('b', 2)), true)
  assert.equal(U.audienceAllows(manifest('b', 2, { audience: { pcs: [] } })), true)
  const m = manifest('b', 2, { audience: { pcs: ['seed-pc'] } })
  assert.equal(U.audienceAllows(m, 'SEED-PC'), true)
  assert.equal(U.audienceAllows(m, 'desk-2'), false)
  assert.equal(U.audienceAllows(m, os.hostname()), os.hostname().toLowerCase() === 'seed-pc')
})

test('the audience is part of the signature: removing it breaks it', () => {
  const m = manifest('c', 3, { audience: { pcs: ['seed-pc'] } })
  const sig = U.signManifest(m, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  assert.equal(U.verifyManifest(m, sig), true)
  const { audience, ...open } = m
  assert.equal(U.verifyManifest(open, sig), false)
  assert.equal(U.verifyManifest({ ...m, audience: { pcs: ['desk-2'] } }, sig), false)
})

test('a PC of the office offers the seeded release: another PC (not in the audience) takes it as newer, only forward', async () => {
  const m = manifest('d', 5, { audience: { pcs: ['seed-pc'] } })
  const signature = U.signManifest(m, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const srv = http.createServer((req, res) => {
    if (req.url === '/lan/latest') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ manifest: m, signature, have: [] })) }
    res.statusCode = 404; res.end()
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  process.env.ADAL_RELEASE_BASES = `http://127.0.0.1:${srv.address().port}/lan`
  try {
    const older = manifest('c', 4)
    const got = await L.newestFromPeers(older, { extra: true })
    assert.equal(got?.manifest.sha, m.sha, 'the office offers it')
    assert.deepEqual(got.manifest.audience, { pcs: ['seed-pc'] })
    assert.equal(await L.newestFromPeers(manifest('e', 9), { extra: true }), null, 'never an older one')
    assert.equal(await L.newestFromPeers(m, { extra: true }), null, 'never the same one')
  } finally { srv.close(); process.env.ADAL_RELEASE_BASES = '' }
})

test('the trail: a PC is first seen on a version once; the list names each PC, its version and since when', async () => {
  const t0 = Date.parse('2026-11-22T09:00:00Z')
  const a = await TR.pcsNow({ version: 'aaaaaaa' }, [{ name: 'DESK-2', version: 'aaaaaaa', at: t0 }, { name: 'DESK-3', version: 'aaaaaaa', at: t0 }], t0)
  assert.equal(a.length, 3); assert.equal(a[0].main, true); assert.ok(a.every(p => p.since === new Date(t0).toISOString()))
  const t1 = t0 + 20 * 60000
  const b = await TR.pcsNow({ version: 'aaaaaaa' }, [{ name: 'DESK-2', version: 'ddddddd', at: t1 }, { name: 'DESK-3', version: 'aaaaaaa', at: t1 }], t1)
  assert.equal(b.find(p => p.name === 'DESK-2').version, 'ddddddd')
  assert.equal(b.find(p => p.name === 'DESK-2').since, new Date(t1).toISOString(), 'since = when it was first seen on the new version')
  assert.equal(b.find(p => p.name === 'DESK-3').since, new Date(t0).toISOString(), 'unchanged PCs keep their time')
  const c = await TR.pcsNow({ version: 'aaaaaaa' }, [{ name: 'DESK-2', version: 'ddddddd', at: t1 + 60000 }], t1 + 60000)
  assert.equal(c.find(p => p.name === 'DESK-2').since, new Date(t1).toISOString())
})
