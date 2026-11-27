/**
 * The REAL brain adapter: two real Adal Keep servers (a Main and a Companion that joined it with the main PC's number, each its own copy of the
 * backend folder, its own port and its own scratch database), the real run claims (POST /api/run-claims/claim|release with the robots' token,
 * GET /api/run-claims), the real PC copying between them, and the mock site. What is NOT the real code, said plainly:
 *   - the queue WORKER: a scratch instance runs with ADAL_ISOLATED=1 (no robots, no background work), so a small "worker" in this file takes
 *     pending rows of an instance's own database and does what worker.js claimedRun does around a run (claim -> run -> release; a refused
 *     claim puts the row back to pending with "Waiting for <pc>"). The run itself is a visit to the mock site.
 *   - Yusuf's gate (robotsMayRunHere: a Companion takes runs only while Main is off) is imitated here: Main always, the Companion only when
 *     Main's /api/health has not answered for GATE_MS.
 *   - the lease sweep (runClaims.startRunClaims) is not started in ISOLATED mode, so it is called here as the server would, every 30 s.
 * Scenarios that need what a scratch instance cannot give throw NotBuilt(why) and are BLOCKED, with the owner named.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'url'

export class NotBuilt extends Error { constructor(what) { super(what); this.notBuilt = true } }
const BACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const HOST = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
export const GATE_MS = 8000   // (Yusuf: 45 s; shortened for the test)

let rig = null     // one rig for the whole run: building it takes ~80 s
async function waitHealth(port, ms = 90000) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true } catch {} await sleep(500) }
  throw new Error(`the server on :${port} did not answer in ${ms / 1000} s`)
}
function copyBackend(to) {
  fs.mkdirSync(to, { recursive: true })
  fs.cpSync(BACK, path.join(to, 'backend'), { recursive: true, filter: (p) => !/(^|\/)(node_modules|data|logs|uploads|tests|scripts)(\/|$)|data\.sqlite/.test(path.relative(BACK, p)) })
  fs.symlinkSync(path.join(BACK, 'node_modules'), path.join(to, 'backend', 'node_modules'))
  return path.join(to, 'backend')
}

async function buildRig() {
  if (!HOST) throw new NotBuilt('this PC has no network address other than loopback (a Companion must reach Main from a non-loopback address, or Main takes it for itself)')
  if (spawnSync(process.execPath, ['-e', "require('node:sqlite')"]).status !== 0) throw new NotBuilt('node:sqlite is not in this Node')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-brain-'))
  const inst = (name, port) => ({ name, port, dir: copyBackend(path.join(root, name)), url: `http://127.0.0.1:${port}`, proc: null, alive: false, log: path.join(root, `${name}.log`) })
  const main = inst('Main', 4181), comp = inst('Comp', 4182)
  const start = (i, extra = {}) => {
    const out = fs.openSync(i.log, 'a')
    i.proc = spawn(process.execPath, ['main.js'], { cwd: i.dir, stdio: ['ignore', out, out], env: { ...process.env, PORT: String(i.port), SQLITE_PATH: path.join(i.dir, 'data.sqlite'), ADAL_ISOLATED: '1', ADAL_NO_PUBLISH: '1', ADAL_PC_NAME: i.name, ADAL_WHATSAPP: '0', ADAL_ROBOT_PROCESS: '', ...extra } })
    i.alive = true
    i.proc.on('exit', () => { i.alive = false })
  }
  rig = { root, main, comp, start, stopped: false }
  start(main); await waitHealth(main.port)
  const num = spawnSync(process.execPath, ['-e', "import('./src/services/mainPC.js').then(m=>console.log(m.pcNumber()))"], { cwd: main.dir, encoding: 'utf8' }).stdout.trim().split('\n').pop()
  const got = await (await fetch(`http://${HOST}:${main.port}/api/pc-access/number`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number: num, name: 'Comp' }) })).json()
  if (!got.key) throw new Error(`the Companion was not let in: ${JSON.stringify(got)}`)
  start(comp, { ADAL_SYNC_JOIN_MAIN: `http://${HOST}:${main.port}`, ADAL_SYNC_JOIN_KEY: got.key, ADAL_JOIN_FIRST_MS: '500' })
  await waitHealth(comp.port)
  for (let i = 0; i < 60 && !/joined \(slot/.test(fs.readFileSync(comp.log, 'utf8')); i++) await sleep(1000)
  if (!/joined \(slot/.test(fs.readFileSync(comp.log, 'utf8'))) throw new Error('the Companion did not join Main: ' + fs.readFileSync(comp.log, 'utf8').split('\n').filter(l => /\[sync\]/.test(l)).slice(-2).join(' | '))
  await stopProc(comp); start(comp); await waitHealth(comp.port)          // the copy goes in at the restart
  for (const i of [main, comp]) fs.writeFileSync(path.join(i.dir, 'data', 'robots-token'), i.token = crypto.randomBytes(16).toString('hex'))
  for (let k = 0; k < 40; k++) { const h = await (await fetch(`${comp.url}/api/health`)).json().catch(() => ({})); if (h.role === 'companion') break; await sleep(1000) }
  rig.mainDownSince = 0
  rig.timer = setInterval(() => workers().catch((e) => { if (process.env.BRAIN_DEBUG) console.error('workers', e.message) }), 700)
  rig.sweep = setInterval(() => sweeps().catch(() => {}), 30000)
  process.on('exit', () => { for (const i of [main, comp]) try { i.proc?.kill('SIGKILL') } catch {} })
  return rig
}
async function stopProc(i) { try { i.proc.kill('SIGKILL') } catch {} i.alive = false; await sleep(800) }

// ---- the emulated worker (worker.js claimedRun around a run) and the gate
const db = (i) => { const d = new DatabaseSync(path.join(i.dir, 'data.sqlite')); d.exec('PRAGMA busy_timeout = 4000'); return d }
const rowsOf = (i) => { const d = db(i); try { return d.prepare('select * from automation_queue order by id').all() } finally { d.close() } }
const setRow = (i, id, patch) => { const d = db(i); try { d.prepare(`update automation_queue set ${Object.keys(patch).map(k => `${k} = ?`).join(', ')}, updated_at = ? where id = ?`).run(...Object.values(patch), new Date().toISOString(), id) } finally { d.close() } }
const call = (i, op, body) => fetch(`${i.url}/api/run-claims/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adal-robots': i.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }).then(r => r.json())
const mayRunHere = async (i) => { if (i === rig.main) return true; const up = await fetch(`${rig.main.url}/api/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false); if (up) rig.mainDownSince = 0; else rig.mainDownSince = rig.mainDownSince || Date.now(); return !up && Date.now() - rig.mainDownSince > GATE_MS }
async function workers() {
  for (const i of [rig.main, rig.comp]) {
    if (!i.alive || i.busy || rig.stopped) continue
    if (!(await mayRunHere(i))) continue
    const row = rowsOf(i).find(r => r.status === 'pending' && !(i.waitUntil?.[r.id] > Date.now()) && !(r.context || '').includes('"_taken"'))
    if (!row) continue
    i.busy = true
    runOne(i, row).catch((e) => { if (process.env.BRAIN_DEBUG) console.error('worker', i.name, e.message) }).finally(() => { i.busy = false })
  }
}
async function runOne(i, row) {
  const job = { id: row.id, profile_id: row.profile_id, workflow_id: row.workflow_id }
  setRow(i, row.id, { status: 'running', started_at: new Date().toISOString() })
  const c = await call(i, 'claim', { job }).catch(() => ({ ok: true, via: 'alone' }))
  if (c.ok === false) { setRow(i, row.id, { status: 'pending', started_at: null, pause_reason: `Waiting for ${c.by || 'another PC'}` }); (i.waitUntil ||= {})[row.id] = Date.now() + 15000; return }
  const girl = [...girls].find(([, id]) => id === row.profile_id)?.[0] ?? row.profile_id, runMs = i.runMs || 400   // (the mock site knows her by the scenario's number)
  const visit = (phase) => fetch(`${rig.site.base}/${phase}?girl=${girl}&pc=${i.name}`).catch(() => {})
  await visit('start')
  const end = Date.now() + runMs
  while (Date.now() < end) { await sleep(150); if (!i.alive) return }       // a dead PC stops here: no end, no release
  await visit('end')
  setRow(i, row.id, { status: 'done', finished_at: new Date().toISOString() })
  await call(i, 'release', { job, result: 'done' }).catch(() => {})
}
async function sweeps() {   // the server's own sweep (startRunClaims) does not run in ISOLATED mode
  for (const i of [rig.main, rig.comp]) if (i.alive) await fetch(`${i.url}/api/run-claims`).catch(() => {})
}

// ---- the adapter
const girls = new Map()    // girl number -> profile id (made once on Main, copied to the Companion)
export async function makeRealBrain({ site } = {}) {
  if (!rig) await buildRig()
  rig.site = site; rig.stopped = false
  const inst = (n) => (n === 'Main' ? rig.main : n === 'Comp' ? rig.comp : null)
  const need = (n) => inst(n) || (() => { throw new NotBuilt(`a third PC ("${n}") — the rig has a Main and one Companion`) })()
  const making = new Map()
  const ensureProfile = (g) => { if (!making.has(g)) making.set(g, makeProfile(g)); return making.get(g) }
  const makeProfile = async (g) => {
    if (girls.has(g)) return girls.get(g)
    const home = rig.main.alive ? rig.main : rig.comp
    const r = await (await fetch(`${home.url}/api/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: `TEST GIRL ${g}`, phone_number: `09110${g}`, passport_number: `EP${5550000 + Number(g)}` }) })).json()
    if (!r.id) throw new Error(`could not make profile ${g}: ${JSON.stringify(r)}`)
    girls.set(g, r.id)
    const other = home === rig.main ? rig.comp : rig.main
    for (let k = 0; k < 40 && other.alive; k++) { if (rowsOfProfiles(other).includes(r.id)) break; await sleep(1000) }
    return r.id
  }
  const rowsOfProfiles = (i) => { const d = db(i); try { return d.prepare('select id from profiles').all().map(x => x.id) } finally { d.close() } }
  return {
    name: 'real', leaseMs: 60000, timeoutMs: 1200000, slackMs: 45000, sweeps: false,
    async addPC(name, o = {}) { const i = need(name); i.runMs = o.runMs; return i },
    async enqueue(name, girl, { wf = 'musaned_check_chosen' } = {}) {
      const i = need(name), pid = await ensureProfile(girl)
      const r = await (await fetch(`${i.url}/api/profiles/${pid}/automations/${wf}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anyStep: true }) })).json()
      if (!r.runId) throw new Error(`the run was not queued on ${name}: ${JSON.stringify(r)}`)
      return r.runId
    },
    async profileId(girl) { return girls.get(girl) },
    async off(name) { await stopProc(need(name)) },
    async on(name) { const i = need(name); rig.start(i); await waitHealth(i.port) },
    cut() { throw new NotBuilt('a way to cut the network between two scratch instances without root: the PC copying and the claims go to the addresses they learned at joining. Needs a switch (e.g. ADAL_BLOCK_PEERS=<file> read by the peer calls in sync/peers.js and runClaims.askPeer) — Umar') },
    heal() { throw new NotBuilt('see cut') },
    async rows(name) { return rowsOf(need(name)) },
    async claims(name) { return (await (await fetch(`${need(name).url}/api/run-claims`)).json()).map(c => ({ key: c.key, state: 'running', pc_name: c.pc_name, run_id: c.run_id })) },
    async runState(name, girl) {
      const i = need(name), pid = girls.get(girl)
      const live = (await (await fetch(`${i.url}/api/run-claims`)).json().catch(() => [])).find(c => String(c.profile_id) === String(pid))
      const row = rowsOf(i).filter(r => r.profile_id === pid).pop()
      if (row?.status === 'failed') return 'failed'
      if (row?.status === 'running' && !live) return 'expired'
      return live ? 'running' : row?.status || null
    },
    async results(name) { return rowsOf(need(name)).filter(r => r.status === 'done').map(r => ({ key: `musaned|${[...girls].find(([, id]) => id === r.profile_id)?.[0] ?? r.profile_id}`, status: 'done' })) },
    async close() { rig.stopped = true; for (const i of [rig.main, rig.comp]) { if (!i.alive) { rig.start(i); await waitHealth(i.port).catch(() => {}) } } },
    async shutdown() { clearInterval(rig.timer); clearInterval(rig.sweep); for (const i of [rig.main, rig.comp]) await stopProc(i); fs.rmSync(rig.root, { recursive: true, force: true }); rig = null },
  }
}
