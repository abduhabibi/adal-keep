#!/usr/bin/env node
/**
 * The release gate: before a release is published (scripts/publish-update.mjs),
 * one fake agency with 3 PCs runs on this PC and must work end to end.
 *
 *   node adal-keep-backend/scripts/release-gate.mjs        (exit 0 only when every step passed)
 *   import { releaseGate } from './release-gate.mjs'; const { ok, steps } = await releaseGate()
 *
 * The 3 PCs are 3 child processes (scripts/gate/sync-pc.mjs), each with its own
 * folder under one temp folder (database, SafeStorage, uploads) and its own port
 * on 127.0.0.1 (4311–4313): Adal Keep's real migrations, the real copying
 * (SyncEngine + SyncNode with its timers) and the real /api/sync routes. PC1
 * is the main PC; PC2 and PC3 join it (/api/sync/join, then a whole copy of
 * its database, as a Companion's first copy) and then only talk the normal way.
 * Not started: the rest of Adal Keep (pages, robots, browser, WhatsApp, the
 * online copy, UDP) — nothing that could reach this PC's real Adal Keep.
 *
 *   1. the 3 PCs start and reach each other
 *   2. a profile made on PC2, edited on PC3, a document uploaded for it on PC1
 *   3. all 3 show the same profile (with the edit) and the document (same SHA-256)
 *   4. PC3 switched off (killed); PC1 changes the profile and uploads another
 *      document meanwhile; PC3 back on its same folder catches up
 *   5. an update on each PC: a throw-away signing key, a signed fake release
 *      (app .tar.gz + a program) installed on PC1, PC2 and PC3 (3 more child
 *      processes, scripts/gate/update-pc.mjs), then a second release given
 *      ONLY as its small patch (updates v2): each PC rebuilds the app from the
 *      first and checks every SHA-256; a badly signed release is refused.
 *      (Since 2026-11-23 nothing goes between PCs: every PC updates from Supabase.)
 *
 * Everything (processes, the temp folder) is cleaned up, also on failure; the
 * whole gate stops after 7 minutes at most.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import { spawn, execFileSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACK = path.join(HERE, '..')
const SYNC_PC = path.join(HERE, 'gate', 'sync-pc.mjs')
const UPDATE_PC = path.join(HERE, 'gate', 'update-pc.mjs')
const SYNC_PORTS = [4311, 4312, 4313]
const BUDGET_MS = 7 * 60 * 1000
// (A document can wait for a PC's next minute round: a round asked for during one is folded into it.)
const CONVERGE_MS = 90 * 1000

/** Every gate running in this process: its processes and folder (cleaned up on Ctrl-C too). */
const running = new Set()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const hex = (n) => crypto.randomBytes(n).toString('hex')
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`

export async function releaseGate({ log = console.log } = {}) {
  const t0 = Date.now()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-release-gate-'))
  const token = hex(24)
  const kids = new Set()
  const me = { kids, root }
  running.add(me)
  const steps = []
  let peak = 0
  const sampler = setInterval(() => { peak = Math.max(peak, rssNow(kids)) }, 300)
  sampler.unref?.()
  // A clean environment for the PCs: nothing of this PC's own Adal Keep (.env, keys, ports) goes in.
  const baseEnv = { PATH: process.env.PATH || '', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), ADAL_ISOLATED: '1', ADAL_SYNC: '1', NODE_ENV: 'test', LANG: 'C.UTF-8' }
  fs.mkdirSync(baseEnv.HOME, { recursive: true }); fs.mkdirSync(baseEnv.TMPDIR, { recursive: true })

  // ── the processes ────────────────────────────────────────────────────────
  function launch(script, env, name) {
    const child = spawn(process.execPath, [script], { cwd: BACK, env: { ...baseEnv, ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const k = { name, child, out: [], err: [], waiters: [], dead: false }
    kids.add(k)
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        k.out.push(line); if (k.out.length > 200) k.out.shift()
        for (const w of [...k.waiters]) if (w.test(line)) { k.waiters.splice(k.waiters.indexOf(w), 1); w.ok(line) }
      }
    })
    child.stderr.on('data', (d) => { k.err.push(String(d)); if (k.err.length > 50) k.err.shift() })
    child.stdin.on('error', () => {})
    child.on('exit', (code, sig) => { k.dead = true; k.exit = sig || code; for (const w of k.waiters.splice(0)) w.no(new Error(`${name} stopped (${sig || code})${tail(k)}`)) })
    return k
  }
  const waitLine = (k, test, ms, what) => new Promise((ok, no) => {
    if (k.dead) return no(new Error(`${k.name} is not running${tail(k)}`))
    const w = { test, ok: (l) => { clearTimeout(t); ok(l) }, no: (e) => { clearTimeout(t); no(e) } }
    const t = setTimeout(() => { k.waiters.splice(k.waiters.indexOf(w), 1); no(new Error(`${k.name}: no ${what} in ${secs(ms)}${tail(k)}`)) }, ms)
    k.waiters.push(w)
  })
  function kill(k, sig = 'SIGKILL') {
    try { process.kill(-k.child.pid, sig) } catch {}
    try { k.child.kill(sig) } catch {}
  }
  const gone = (k) => k.dead ? Promise.resolve() : new Promise(r => { k.child.once('exit', r); setTimeout(r, 5000) })

  // ── step bookkeeping ─────────────────────────────────────────────────────
  async function step(name, fn) {
    const s = Date.now()
    if (fn === null) {
      steps.push({ name, ok: false, ms: 0, note: 'not run: a step before it failed' })
      log(`  ✗ ${name} — not run: a step before it failed`)
      return false
    }
    try {
      const note = await fn()
      steps.push({ name, ok: true, ms: Date.now() - s, note: note || '' })
      log(`  ✓ ${name} (${secs(Date.now() - s)})${note ? ` — ${note}` : ''}`)
      return true
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - s, note: e.message })
      log(`  ✗ ${name} (${secs(Date.now() - s)}) — ${e.message}`)
      return false
    }
  }

  // ── PC helpers (the sync PCs) ────────────────────────────────────────────
  const pcs = ['PC1', 'PC2', 'PC3'].map((name, i) => ({ name, port: SYNC_PORTS[i], url: `http://127.0.0.1:${SYNC_PORTS[i]}`, dir: path.join(root, name), pcId: hex(6), key: crypto.randomBytes(32).toString('base64url'), slot: i === 0 ? 1 : null, k: null }))
  const [pc1, pc2, pc3] = pcs
  async function call(pc, method, p, body, extra = {}) {
    const r = await fetch(`${pc.url}${p}`, { method, signal: AbortSignal.timeout(15000), headers: { 'x-gate-token': token, ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`${pc.name} ${p}: ${j.error || r.status}`)
    return j
  }
  async function startPC(pc) {
    fs.mkdirSync(pc.dir, { recursive: true })
    pc.k = launch(SYNC_PC, { GATE_DIR: pc.dir, GATE_ROOT: root, GATE_PORT: String(pc.port), GATE_NAME: pc.name, GATE_SLOT: String(pc.slot), GATE_PCID: pc.pcId, GATE_KEY: pc.key, GATE_TOKEN: token, GATE_MAIN_URL: pc === pc1 ? '' : pc1.url, GATE_CLAIM: pc === pc1 ? '1' : '0' }, pc.name)
    await waitLine(pc.k, l => l.startsWith('READY'), 60000, 'start')
  }
  const state = (pc, pid) => call(pc, 'GET', `/gate/state${pid ? `?pid=${pid}` : ''}`)
  /** Polls until test(states) is true for the PCs given; returns the ms it took. */
  async function until(list, pid, test, ms, what) {
    const s = Date.now()
    let last = null, lastErr = null
    while (Date.now() - s < ms) {
      try {
        last = await Promise.all(list.map(pc => state(pc, pid)))
        if (test(last)) return Date.now() - s
      } catch (e) { lastErr = e }
      await sleep(250)
    }
    throw new Error(`${what}: not within ${secs(ms)}${lastErr ? ` (${lastErr.message})` : ''}${last ? ` — ${describe(last)}` : ''}`)
  }
  const describe = (sts) => sts.map(s => `${s.name}: ${s.profile ? `"${s.profile.full_name}"/${s.profile.status}` : 'no profile'}, docs ${s.uploads.filter(u => u.have && u.have === u.want).length}/${s.uploads.length}, reached ${s.pcs.filter(p => p.reached).length}/${s.pcs.length}${s.pcs.filter(p => p.error && !p.reached).map(p => ` (${p.name}: ${p.error})`).join('')}`).join('; ')

  let profileId = null
  const want = {}          // what every PC must show
  const docs = []          // sha256 of each document uploaded
  const same = (sts) => sts.every(s => s.profile
    && Object.entries(want).every(([k, v]) => s.profile[k] === v)
    && docs.every(h => s.uploads.some(u => u.want === h && u.have === h)))

  const run = async () => {
    log(`release gate: one fake agency, 3 PCs on this PC (${root})`)
    // 1 ─────────────────────────────────────────────────────────────────────
    const ok1 = await step('1. three PCs start (main + 2 joined) and reach each other', async () => {
      await startPC(pc1)
      for (const pc of [pc2, pc3]) {
        // In with the gate's token (where a Companion uses the main PC's number), then the main PC's database whole.
        const j = await call(pc1, 'POST', '/api/sync/join', { pc_id: pc.pcId, name: pc.name, lan: ['127.0.0.1'], port: pc.port }, { 'x-adal-pc': pc.key })
        pc.slot = j.slot
        fs.mkdirSync(pc.dir, { recursive: true })
        await call(pc1, 'POST', '/gate/snapshot', { to: path.join(pc.dir, 'data.sqlite') })
      }
      await Promise.all([startPC(pc2), startPC(pc3)])
      const ms = await until(pcs, null, sts => sts.every(s => s.pcs.length === 3 && s.pcs.every(p => p.reached)) && sts.every(s => s.holder === pc1.pcId), 45000, 'the 3 PCs reaching each other')
      return `slots ${pcs.map(p => p.slot).join('/')}, all reached each other ${secs(ms)} after start`
    })
    // 2 ─────────────────────────────────────────────────────────────────────
    const ok2 = await step('2. profile made on PC2, edited on PC3, document uploaded on PC1', !ok1 ? null : async () => {
      const passport = `EP${String(Date.now()).slice(-7)}`
      const r = await call(pc2, 'POST', '/gate/profile', { full_name: 'Gate Test Worker', passport_number: passport, notes: 'made on PC2' })
      profileId = r.id
      if (Number(profileId) % 1000 !== pc2.slot) throw new Error(`the id ${profileId} made on PC2 does not end in its slot ${pc2.slot}`)
      const toPc3 = await until([pc3], profileId, ([s]) => !!s.profile, 30000, 'the new profile reaching PC3')
      await call(pc3, 'POST', '/gate/edit', { id: profileId, set: { full_name: 'Gate Test Worker (edited on PC3)', notes: 'edited on PC3' } })
      Object.assign(want, { passport_number: passport, full_name: 'Gate Test Worker (edited on PC3)', notes: 'edited on PC3' })
      const toPc1 = await until([pc1], profileId, ([s]) => !!s.profile, 30000, 'the profile reaching PC1')
      const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(24 * 1024), Buffer.from([0xff, 0xd9])])
      const u = await call(pc1, 'POST', '/gate/upload', { profile_id: profileId, name: 'photo.jpg', b64: photo.toString('base64') })
      docs.push(u.sha256)
      return `PC2→PC3 ${secs(toPc3)}, then on PC1 ${secs(toPc1)}; 24 KB photo uploaded on PC1`
    })
    // 3 ─────────────────────────────────────────────────────────────────────
    const ok3 = await step('3. all 3 PCs show the same profile, with the edit and the document', !ok2 ? null : async () => {
      const ms = await until(pcs, profileId, same, CONVERGE_MS, 'converging')
      return `converged in ${secs(ms)}`
    })
    // 4 ─────────────────────────────────────────────────────────────────────
    const ok4 = await step('4. PC3 switched off, PC1 changes meanwhile, PC3 back catches up', !ok3 ? null : async () => {
      kill(pc3.k)
      await gone(pc3.k)
      await call(pc1, 'POST', '/gate/edit', { id: profileId, set: { status: 'changed while PC3 was off', notes: 'edited on PC1, PC3 off' } })
      Object.assign(want, { status: 'changed while PC3 was off', notes: 'edited on PC1, PC3 off' })
      const doc2 = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(16 * 1024)])
      const u = await call(pc1, 'POST', '/gate/upload', { profile_id: profileId, name: 'passport.pdf', b64: doc2.toString('base64') })
      docs.push(u.sha256)
      const toPc2 = await until([pc1, pc2], profileId, same, CONVERGE_MS, 'PC2 getting the change while PC3 is off')
      const s = Date.now()
      await startPC(pc3)   // the same folder: its database as it was when it went off
      const back = await until(pcs, profileId, same, CONVERGE_MS, 'PC3 catching up')
      return `PC2 had it in ${secs(toPc2)}; PC3 caught up ${secs(Date.now() - s)} after it was switched on (${secs(back)} after it answered)`
    })
    // 5 ─────────────────────────────────────────────────────────────────────
    // (The sync PCs are done: stopped first, so this PC carries fewer processes at once.)
    for (const pc of pcs) if (pc.k) kill(pc.k)
    await Promise.all(pcs.filter(p => p.k).map(p => gone(p.k)))
    const ok5 = await step('5. a signed update on each PC, the next one rebuilt from a small patch', () => updateEach())
    return ok1 && ok2 && ok3 && ok4 && ok5
  }

  async function updateEach() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    const pub = publicKey.export({ type: 'spki', format: 'pem' })
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' })
    // canonical + signManifest: the same code publish-update.mjs signs with (no key of Adal's is used).
    const { signManifest } = await import(pathToFileURL(path.join(BACK, 'src', 'services', 'updateChannel.js')).href)
    const rel = path.join(root, 'release')
    fs.mkdirSync(rel, { recursive: true })
    const piece = (name, buf) => { const f = path.join(rel, name); fs.writeFileSync(f, buf); return { path: f, sha256: sha256(buf), size: buf.length } }
    const appTar = (v) => makeTar(path.join(rel, `app-${v}`), v)

    const lans = ['PC1', 'PC2', 'PC3'].map((name) => ({ name, dir: path.join(root, `lan-${name}`), k: null, n: 0 }))
    const [l1] = lans
    for (const l of lans) {
      fs.mkdirSync(l.dir, { recursive: true })
      l.k = launch(UPDATE_PC, { ADAL_LAN_RELEASE_DIR: l.dir }, `${l.name} (updates)`)
      // The throw-away PUBLIC key, in-process to that PC (its stdin): never the environment, a file or the network.
      l.k.child.stdin.write(JSON.stringify({ pub }) + '\n')
    }
    await Promise.all(lans.map(l => waitLine(l.k, s => s.startsWith('{"ready"'), 30000, 'start')))
    const ask = async (l, cmd, ms = 60000) => {
      const id = ++l.n
      const p = waitLine(l.k, s => { try { return JSON.parse(s).id === id } catch { return false } }, ms, `answer to ${cmd.op}`)
      l.k.child.stdin.write(JSON.stringify({ ...cmd, id }) + '\n')
      const j = JSON.parse(await p)
      if (!j.ok) throw new Error(`${l.name} ${cmd.op}: ${j.error}`)
      return j
    }

    // Release 1: the app (.tar.gz, and its plain .tar as updates v2 names it) and a program.
    const raw1 = appTar(1)
    const gz1 = piece('app1.tar.gz', zlib.gzipSync(raw1.buf, { level: 9 }))
    const tar1 = piece('app1.tar', raw1.buf)
    const prog = piece('AdalKeep.exe', Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(256 * 1024)]))
    const sha1 = hex(20)
    const m1 = {
      sha: sha1, short: sha1.slice(0, 7), seq: 1, published_at: new Date(Date.now() - 60000).toISOString(), date: new Date(Date.now() - 120000).toISOString(),
      file: `release/${sha1}.tar.gz`, sha256: gz1.sha256, size: gz1.size, app_delta: { raw: { sha256: tar1.sha256, size: tar1.size } },
      programs: [{ name: 'AdalKeep.exe', file: `programs/${prog.sha256}-AdalKeep.exe`, sha256: prog.sha256, size: prog.size }],
      notes: ['release gate (fake)'],
    }
    const s = Date.now()
    await Promise.all(lans.map(l => ask(l, { op: 'install', env: { manifest: m1, signature: signManifest(m1, priv) }, pieces: [gz1, tar1, prog] })))
    const states = await Promise.all(lans.map(l => ask(l, { op: 'state' })))
    for (const [i, st] of states.entries()) if (st.sha !== sha1 || !st.complete) throw new Error(`${lans[i].name} does not keep release 1 whole`)
    // A tampered release is refused: the same manifest with another piece, signed by nobody.
    const bad = { ...m1, seq: 9, sha: hex(20), sha256: hex(32) }
    const r3 = await ask(l1, { op: 'install', env: { manifest: bad, signature: signManifest(m1, priv) }, pieces: [] }).then(() => 'kept', e => e.message)
    if (r3 === 'kept') throw new Error('PC1 kept a release whose signature does not match')
    let note = `release 1 (${((gz1.size + prog.size) / 1024).toFixed(0)} KB) kept whole on 3 PCs in ${secs(Date.now() - s)}; a badly signed release refused`

    // Release 2: only the app's small patch from release 1 is handed in (as Supabase would send it).
    const { diff } = await import(pathToFileURL(path.join(BACK, 'src', 'services', 'bsdiff.js')).href)
    const raw2 = appTar(2)
    const gz2 = piece('app2.tar.gz', zlib.gzipSync(raw2.buf, { level: 9 }))
    const tar2 = piece('app2.tar', raw2.buf)
    const pat = piece('app2.adalpatch', diff(raw1.buf, raw2.buf))
    const sha2 = hex(20)
    const m2 = {
      ...m1, sha: sha2, short: sha2.slice(0, 7), seq: 2, published_at: new Date().toISOString(), date: new Date(Date.now() - 30000).toISOString(),
      file: `release/${sha2}.tar.gz`, sha256: gz2.sha256, size: gz2.size,
      app_delta: { raw: { sha256: tar2.sha256, size: tar2.size }, patch: { from: tar1.sha256, from_gz: gz1.sha256, file: `release/patches/${sha2}-from-${sha1.slice(0, 12)}.adalpatch`, sha256: pat.sha256, size: pat.size } },
    }
    const s2 = Date.now()
    const got = await Promise.all(lans.map(l => ask(l, { op: 'patch', env: { manifest: m2, signature: signManifest(m2, priv) }, pieces: [pat] })))
    for (const [i, r] of got.entries()) {
      if (r.sha !== sha2 || !r.complete) throw new Error(`${lans[i].name}: release 2 not complete`)
      const app = r.pieces.find(p => p.file === m2.file)
      if (!app || app.sha256 !== tar2.sha256 || !r.patched.length) throw new Error(`${lans[i].name}: the app was not rebuilt from the patch (${app?.form || 'missing'}${r.patched.length ? '' : ', no patch used'})`)
    }
    note += `; delta: app ${(tar2.size / 1024).toFixed(0)} KB rebuilt on 3 PCs from a ${(pat.size / 1024).toFixed(1)} KB patch in ${secs(Date.now() - s2)}`
    return note
  }

  let ok = false, error = null
  let deadline = null
  try {
    ok = await Promise.race([
      run(),
      new Promise((_, no) => { deadline = setTimeout(() => no(new Error(`the gate took longer than ${secs(BUDGET_MS)}`)), BUDGET_MS) }),
    ])
  } catch (e) {
    error = e
    steps.push({ name: 'gate', ok: false, ms: Date.now() - t0, note: e.message })
    log(`  ✗ ${e.message}`)
  } finally {
    clearTimeout(deadline)
    clearInterval(sampler)
    peak = Math.max(peak, rssNow(kids))
    for (const k of kids) kill(k, 'SIGKILL')
    await Promise.all([...kids].map(gone))
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    running.delete(me)
  }
  const ms = Date.now() - t0
  const passed = steps.filter(s => s.ok).length
  ok = !!ok && !error && passed === 5 && steps.length === 5
  log(`release gate: ${ok ? '✓' : '✗'} ${passed}/5 in ${Math.round(ms / 1000)} s (peak memory of the PCs ${Math.round(peak / 1048576)} MB)`)
  return { ok, steps, ms, peakMB: Math.round(peak / 1048576) }
}

/** The memory the gate's PCs hold now (their process groups' RSS, from /proc on Linux). */
function rssNow(kids) {
  let sum = 0
  for (const k of kids) {
    if (k.dead) continue
    try { sum += Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${k.child.pid}/status`, 'utf8'))?.[1] || 0) * 1024 } catch {}
  }
  return sum
}

/** A small real .tar of a fake app (version v): tar when there is one, else plain bytes. */
function makeTar(dir, v) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  const seed = crypto.createHash('sha256').update('adal-gate-app').digest()
  let body = ''
  for (let i = 0; i < 4000; i++) body += `export const line${i} = '${crypto.createHash('sha256').update(seed).update(String(i)).digest('hex')}'\n`
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), body)
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: v }))
  if (v > 1) fs.appendFileSync(path.join(dir, 'src', 'app.js'), `export const fixed = 'in version ${v}'\n`)
  const out = `${dir}.tar`
  try {
    execFileSync('tar', ['--mtime=2026-01-01', '--owner=0', '--group=0', '--numeric-owner', '-cf', out, '-C', dir, '.'], { stdio: 'ignore' })
    return { buf: fs.readFileSync(out) }
  } catch {
    return { buf: Buffer.concat([fs.readFileSync(path.join(dir, 'version.json')), fs.readFileSync(path.join(dir, 'src', 'app.js'))]) }
  }
}

const tail = (k) => { const t = (k.err.join('') || '').trim().split('\n').slice(-4).join(' | '); return t ? ` [${t.slice(0, 600)}]` : '' }

// Run directly: exit 0 only when every step passed.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stopping = false
  const bail = () => {
    if (stopping) return
    stopping = true
    console.log('release gate: stopped')
    for (const g of running) {
      for (const k of g.kids) { try { process.kill(-k.child.pid, 'SIGKILL') } catch {} }
      try { fs.rmSync(g.root, { recursive: true, force: true }) } catch {}
    }
    process.exit(1)
  }
  process.on('SIGINT', bail); process.on('SIGTERM', bail)
  const r = await releaseGate()
  process.exit(r.ok ? 0 : 1)
}
