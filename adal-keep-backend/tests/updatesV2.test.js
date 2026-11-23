// Updates v2 (docs/updates-v2.md): patches (from Supabase only, 2026-11-23), the staged rollout, going back by itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import zlib from 'zlib'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-v2-'))
process.env.ADAL_LAN_RELEASE_DIR = path.join(TMP, 'lan')
process.env.ADAL_UNDO_DIR = path.join(TMP, 'data')
// Supabase is a fake on this PC (peer() below): signed in already.
process.env.SUPABASE_ANON_KEY = 'anon'
process.env.SUPABASE_URL = 'http://127.0.0.1:1'
process.env.ADAL_CHAT_SESSION_FILE = path.join(TMP, 'session.json')
fs.writeFileSync(process.env.ADAL_CHAT_SESSION_FILE, JSON.stringify({ access_token: 'test-token', expires_at: Date.now() + 3600 * 1000 }))
const { diff, patch } = await import('../src/services/bsdiff.js')
const L = await import('../src/services/lanRelease.js')
const U = await import('../src/services/updateChannel.js')
const R = await import('../src/services/rollout.js')
const Undo = await import('../src/services/autoUndo.js')

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const FILES = path.join(process.env.ADAL_LAN_RELEASE_DIR, 'files')
fs.mkdirSync(FILES, { recursive: true })

// A pretend program / app: mostly the same bytes, a few changed, some moved, some added.
function versions(n = 300_000) {
  const old = Buffer.alloc(n)
  let x = 7
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; old[i] = (x >> 16) & 255 }
  const nw = Buffer.concat([old.subarray(0, 1000), Buffer.from('a new function here'), old.subarray(1000, 200_000), old.subarray(250_000), old.subarray(200_000, 210_000)])
  for (let i = 5000; i < n - 100_000; i += 9973) nw[i] ^= 0x55
  return { old, nw }
}

test('bsdiff: the patch rebuilds the new file exactly, and is small', () => {
  const { old, nw } = versions()
  const p = diff(old, nw)
  assert.ok(p.length < nw.length / 10, `patch ${p.length} for ${nw.length}`)
  assert.ok(patch(old, p).equals(nw))
  assert.ok(patch(Buffer.alloc(0), diff(Buffer.alloc(0), nw)).equals(nw)) // from nothing
  assert.ok(patch(old, diff(old, Buffer.alloc(0))).equals(Buffer.alloc(0)))
})

test('bsdiff: a damaged patch is refused, never a wrong file', () => {
  const { old, nw } = versions(50_000)
  const p = diff(old, nw)
  assert.throws(() => patch(old, Buffer.from('not a patch at all, really not')))
  const cut = p.subarray(0, p.length - 10)
  assert.throws(() => patch(old, cut))
})

// Supabase on this PC: serves the release's files by name (no Range: the whole file, as some servers do).
async function peer(files) {
  const asked = []
  const srv = http.createServer((req, res) => {
    const s = decodeURIComponent(req.url.split('/adal-updates/')[1] || '')
    asked.push(s)
    const b = files[s]
    if (!b) { res.statusCode = 404; return res.end() }
    res.setHeader('Content-Length', b.length)
    res.end(b)
  })
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok))
  process.env.SUPABASE_URL = `http://127.0.0.1:${srv.address().port}`
  return { asked, close: () => { srv.close(); process.env.SUPABASE_URL = 'http://127.0.0.1:1' } }
}

function appRelease() {
  const { old, nw } = versions()
  const oldGz = zlib.gzipSync(old), newGz = zlib.gzipSync(nw)
  const p = diff(old, nw)
  const m = {
    sha: 'f'.repeat(40), file: 'release/new.tar.gz', sha256: sha(newGz), size: newGz.length,
    app_delta: { raw: { sha256: sha(nw), size: nw.length }, patch: { from: sha(old), from_gz: sha(oldGz), file: 'release/patches/x.adalpatch', sha256: sha(p), size: p.length } },
  }
  return { old, nw, oldGz, newGz, p, m }
}
const clean = () => { for (const f of fs.readdirSync(FILES)) fs.rmSync(path.join(FILES, f), { force: true }) }

test('the app: rebuilt from the release before (kept as .tar.gz) + the patch from Supabase; only the patch travels', async () => {
  clean()
  const r = appRelease()
  fs.writeFileSync(path.join(FILES, sha(r.oldGz)), r.oldGz) // what the PC kept of the release before
  const pc = await peer({ [r.m.app_delta.patch.file]: r.p, [r.m.file]: r.newGz })
  try {
    const dest = path.join(TMP, 'app.tar')
    await L.fetchPiece(r.m, { file: r.m.file, sha256: r.m.sha256 }, dest)
    assert.ok(fs.readFileSync(dest).equals(r.nw))
    assert.deepEqual(pc.asked, [r.m.app_delta.patch.file])
    // Kept in its plain form (the next patch starts from it).
    assert.equal(L.completeHere(r.m), true)
    assert.ok(L.haveOf(r.m).includes(r.m.app_delta.raw.sha256))
  } finally { pc.close() }
})

test('a damaged patch, or ADAL_DELTA=0: the whole piece instead (from Supabase)', async () => {
  clean()
  const r = appRelease()
  fs.writeFileSync(path.join(FILES, sha(r.oldGz)), r.oldGz)
  const bad = Buffer.from(r.p); bad[bad.length - 5] ^= 1
  const pc = await peer({ [r.m.app_delta.patch.file]: bad, [r.m.file]: r.newGz })
  try {
    const got = await L.fetchPiece(r.m, { file: r.m.file, sha256: r.m.sha256 }, null)
    assert.equal(sha(fs.readFileSync(got)), r.m.sha256)
    clean(); fs.writeFileSync(path.join(FILES, sha(r.oldGz)), r.oldGz)
    process.env.ADAL_DELTA = '0'
    pc.asked.length = 0
    await L.fetchPiece(r.m, { file: r.m.file, sha256: r.m.sha256 }, null)
    assert.ok(!pc.asked.includes(r.m.app_delta.patch.file))
  } finally { delete process.env.ADAL_DELTA; pc.close() }
})

test('a program: patched from the one installed on this PC', async () => {
  clean()
  const { old, nw } = versions(120_000)
  const p = diff(old, nw)
  const installed = path.join(TMP, 'AdalKeep.exe')
  fs.writeFileSync(installed, old)
  const prog = { name: 'AdalKeep.exe', file: 'programs/x-AdalKeep.exe', sha256: sha(nw), size: nw.length, patch: { from: sha(old), file: 'programs/patches/y', sha256: sha(p), size: p.length } }
  const m = { sha: 'e'.repeat(40), file: 'release/e.tar.gz', sha256: 'a'.repeat(64), programs: [prog] }
  const pc = await peer({ [prog.patch.file]: p })
  try {
    const dest = path.join(TMP, 'new.exe')
    await L.fetchPiece(m, prog, dest, { local: [installed] })
    assert.ok(fs.readFileSync(dest).equals(nw))
    assert.deepEqual(pc.asked, [prog.patch.file])
  } finally { pc.close() }
})

test('every form a signed piece has is kept; the 32-bit programs only when here', () => {
  const m = { sha: '1'.repeat(40), file: 'a', sha256: 'a'.repeat(64), app_delta: { raw: { sha256: 'b'.repeat(64) }, patch: { file: 'p', sha256: 'c'.repeat(64), from: 'd'.repeat(64) } },
    programs: [{ name: 'AdalKeep.exe', file: 'f', sha256: 'e'.repeat(64) }], programs_x86: [{ name: 'AdalKeep.exe', file: 'g', sha256: '9'.repeat(64) }] }
  assert.deepEqual(L.piecesOf(m).map(L.formsOf).flat(), ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'e'.repeat(64)])
  assert.equal(L.piecesOf(m, { all: true }).length, 3)
})

test('rollout: the test agency, then ~10% of agencies, then everyone; Admin can stop, resume and advance', () => {
  const t0 = Date.parse('2026-11-23T10:00:00Z'), H = 3600e3
  const m = { sha: 'abc123', rollout: R.newRollout({ test: ['agency-test'], pct: 10, holdHours: 1, now: t0 }) }
  const agencies = Array.from({ length: 1000 }, (_, i) => `agency-${i}`)
  assert.equal(R.itsTurn(m, 'agency-test', t0), true)
  assert.equal(agencies.filter(a => R.itsTurn(m, a, t0)).length, 0)
  const tenth = agencies.filter(a => R.itsTurn(m, a, t0 + H + 1)).length
  assert.ok(tenth > 60 && tenth < 140, `${tenth} of 1000`)
  assert.equal(agencies.every(a => R.itsTurn(m, a, t0 + 2 * H)), true)
  assert.equal(R.itsTurn(m, null, t0 + H + 1), false) // unknown agency: the last
  assert.equal(R.stageOf(m, t0), 'test'); assert.equal(R.stageOf(m, t0 + H), 'pct'); assert.equal(R.stageOf(m, t0 + 2 * H), 'everyone')
  // Stopped: nobody new, older PCs wait for ever too.
  const s = R.changeRollout(m, 'stop', t0 + 10)
  assert.equal(R.itsTurn(s, 'agency-test', t0 + 3 * H), false)
  assert.equal(s.everyone_at, R.FAR); assert.deepEqual(s.early, [])
  // Advance: the 10% now; again: everyone now.
  const a1 = R.changeRollout(m, 'advance', t0 + 60e3)
  assert.equal(R.stageOf(a1, t0 + 60e3), 'pct')
  const a2 = R.changeRollout(a1, 'advance', t0 + 120e3)
  assert.equal(R.stageOf(a2, t0 + 120e3), 'everyone')
  assert.equal(a2.everyone_at, new Date(t0 + 120e3).toISOString())
  assert.equal(R.stageOf(R.changeRollout(s, 'resume', t0 + 20), t0 + 20), 'test')
  // The same buckets as the Companion (adal-companion selfupdate.go itsTurn).
  assert.equal(R.bucket('abc123', 'agency-1'), 11)
  // Older releases: early / everyone_at as before.
  assert.equal(R.itsTurn({ everyone_at: new Date(t0 + H).toISOString(), early: ['x'] }, 'x', t0), true)
  assert.equal(R.itsTurn({ everyone_at: new Date(t0 + H).toISOString(), early: ['x'] }, 'y', t0), false)
})

test('32-bit Windows gets the 386 programs, never a 64-bit one', () => {
  assert.equal(R.pcArch({ PROCESSOR_ARCHITECTURE: 'x86' }), 'x86')
  assert.equal(R.pcArch({ PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' }), 'x64') // 32-bit Node on 64-bit Windows
  assert.equal(R.pcArch({ PROCESSOR_ARCHITECTURE: 'AMD64' }), 'x64')
  const m = { programs: [{ name: 'a' }], programs_x86: [{ name: 'b' }] }
  assert.deepEqual(R.programsFor(m, 'x86').list, [{ name: 'b' }])
  assert.deepEqual(R.programsFor({ programs: [{ name: 'a' }] }, 'x86'), { list: [], missing: true })
  assert.deepEqual(R.programsFor(m, 'x64').list, [{ name: 'a' }])
})

test('auto-undo: a failed self-check goes back, says why, and keeps the release away until Adal assigns', async () => {
  Undo._resetForTests()
  const to = { sha: '7'.repeat(40), short: '7777777' }, from = { sha: '6'.repeat(40), short: '6666666' }
  Undo.beginProbation({ to, from })
  const asked = []
  Undo.setUndoer(async (why) => { asked.push(why); return { ok: true, to: '6666666' } })
  const p = Undo.watch({ installedSha: to.sha, checkAfter: 10, checks: { files: async () => '2 file(s) not as signed', database: async () => '' } })
  assert.equal(p.boots, 1)
  await new Promise(r => setTimeout(r, 80))
  assert.equal(asked.length, 1)
  assert.match(asked[0], /self-check: files: 2 file\(s\) not as signed/)
  const row = Undo.blocked(to.sha)
  assert.equal(row.status, 'rolled-back'); assert.equal(row.to, '6666666')
  assert.equal(Undo.probation(), null)
  assert.match(Undo.forReport().at(-1).reason, /self-check/)

  // Admin's decision, signed on Adal's PC (here a throw-away key, in this process only).
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  U._setVerifyKeyForTests(publicKey.export({ type: 'spki', format: 'pem' }))
  const later = new Date(Date.parse(row.at) + 1000).toISOString()
  const assign = { kind: 'assign', at: later, rules: [{ sha: to.sha.slice(0, 7), pc: 'another-pc', action: 'retry', at: later }, { sha: to.sha, action: 'keep', at: later }] }
  const env = { manifest: assign, signature: U.signManifest(assign, privateKey.export({ type: 'pkcs8', format: 'pem' })) }
  assert.deepEqual(Undo.readAssign({ ...env, signature: 'AAAA' }), []) // not signed: nothing
  const rules = Undo.readAssign(env)
  assert.equal(Undo.decisionFor(rules, row), 'keep')
  assert.equal(Undo.decisionFor(rules, row, { pc: 'another-pc' }), 'retry')
  assert.equal(Undo.decisionFor([{ ...rules[1], at: '2020-01-01T00:00:00Z' }], row), null) // older than the report: not for it
  Undo.settle(to.sha, 'keep')
  assert.equal(Undo.blocked(to.sha).status, 'kept')
  Undo.settle(to.sha, 'retry')
  assert.equal(Undo.blocked(to.sha), null)
  U._setVerifyKeyForTests(null)
})

test('auto-undo: a crash loop after the update goes back; clean exits do not count', async () => {
  Undo._resetForTests()
  const to = { sha: '8'.repeat(40), short: '8888888' }
  Undo.beginProbation({ to, from: { sha: '6'.repeat(40) } })
  const asked = []
  Undo.setUndoer(async (why) => { asked.push(why); return { ok: true } })
  const f = path.join(process.env.ADAL_UNDO_DIR, 'update-probation.json')
  const pr = JSON.parse(fs.readFileSync(f, 'utf8'))
  fs.writeFileSync(f, JSON.stringify({ ...pr, boots: 3, cleanExits: 1 })) // 3 starts, 1 on purpose: 1 crash so far
  Undo.watch({ installedSha: to.sha, checkAfter: 1e9 })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(asked.length, 0) // boots 4, clean 1 → 2 crashes
  Undo.watch({ installedSha: to.sha, checkAfter: 1e9 })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(asked.length, 1)
  assert.match(asked[0], /crashed 3 times/)
})

test('auto-undo: the files are compared with the signed per-file list', () => {
  const root = path.join(TMP, 'install'), back = path.join(root, 'adal-keep-backend')
  fs.mkdirSync(path.join(back, 'src'), { recursive: true })
  fs.writeFileSync(path.join(back, 'src', 'a.js'), 'one')
  fs.writeFileSync(path.join(back, 'server.js'), 'two')
  const files = { 'adal-keep-backend/src/a.js': sha('one'), 'adal-keep-backend/server.js': sha('changed'), 'adal-keep-backend/bin/x.exe': sha('?') }
  assert.deepEqual(Undo.filesDiffer(files, root, back), ['adal-keep-backend/server.js'])
})
