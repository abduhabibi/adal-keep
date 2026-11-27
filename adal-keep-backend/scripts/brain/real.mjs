/**
 * The REAL brain adapter: two real Adal Keep servers (a Main and a Companion that joined it with the main PC's number, each its own copy of the
 * backend folder, its own port and its own scratch database), the real queue worker, the real run claims and lease sweep, the real gate for a
 * Companion (robotsEverywhere), the real PC copying, and the mock site. The only thing replaced is the robot run itself: the worker calls
 * scripts/brain/runner.mjs (ADAL_BRAIN_TEST_RUNNER, Yusuf) which visits the mock site instead of driving a browser. The network cut is
 * ADAL_BLOCK_PEERS (Umar). Scenario 1 needs a third PC and Companion-to-Companion routing (Yusuf, not built): BLOCKED.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'url'
import net from 'net'

export class NotBuilt extends Error { constructor(what) { super(what); this.notBuilt = true } }
const BACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const HOST = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
export const GATE_MS = 8000   // (Yusuf: 45 s; shortened for the test)

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '0.0.0.0', () => { const p = s.address().port; s.close(() => res(p)) }); s.on('error', rej) })   // (two people may run the test at once)
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `adal-brain-${process.pid}-`))   // (only this run's folder is ever removed)
  const inst = (name, port) => ({ name, port, block: null, dir: copyBackend(path.join(root, name)), url: `http://127.0.0.1:${port}`, proc: null, alive: false, log: path.join(root, `${name}.log`) })
  const main = inst('Main', await freePort()), comp = inst('Comp', await freePort())
  const start = (i, extra = {}) => {
    const out = fs.openSync(i.log, 'a')
    i.proc = spawn(process.execPath, ['main.js'], { cwd: i.dir, stdio: ['ignore', out, out], env: { ...process.env, PORT: String(i.port), SQLITE_PATH: path.join(i.dir, 'data.sqlite'), ADAL_ISOLATED: '1', ADAL_NO_PUBLISH: '1', ADAL_PC_NAME: i.name, ADAL_WHATSAPP: '0', ADAL_ROBOTS_IN_APP: '1', ADAL_BRAIN_TEST_RUNNER: path.join(BACK, 'scripts', 'brain', 'runner.mjs'), ADAL_BRAIN_CTL: path.join(i.dir, 'brain-ctl.json'), ADAL_BRAIN_POWER: path.join(i.dir, 'brain-power.json'), ADAL_AGENCY_MANAGER: '0', ADAL_RUN_CLAIMS_SWEEP: '1', ADAL_BLOCK_PEERS: path.join(i.dir, 'block-peers.txt'), ...extra } })
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
  for (let k = 0; k < 40; k++) { const h = await (await fetch(`${comp.url}/api/health`)).json().catch(() => ({})); if (h.role === 'companion') break; await sleep(1000) }
  process.on('exit', () => { for (const i of [main, comp]) try { i.proc?.kill('SIGKILL') } catch {} })
  return rig
}
async function stopProc(i) { try { i.proc.kill('SIGKILL') } catch {} i.alive = false; await sleep(800) }

const db = (i) => { const d = new DatabaseSync(path.join(i.dir, 'data.sqlite')); d.exec('PRAGMA busy_timeout = 4000'); return d }
const rowsOf = (i) => { const d = db(i); try { return d.prepare('select * from automation_queue order by id').all() } finally { d.close() } }
// The PCs the real selfAssign chooses among (Yusuf: ADAL_BRAIN_POWER; Main has id ''; a PC needs 4+ cores to be chosen; strength = cores).
// A PC without a server ("Fast") only needs an entry here: in production Main drives the chosen PC's browser, so the run is still Main's worker.
const writePower = () => { for (const i of [rig.main, rig.comp]) fs.writeFileSync(path.join(i.dir, 'brain-power.json'), JSON.stringify(Object.entries(rig.power || {}).map(([name, strength]) => ({ id: name === 'Main' ? '' : name.toLowerCase(), name, ...(strength <= 1 ? { cores: 2, mem_gb: 4, free_gb: 0.5, load: 60 } : strength <= 5 ? { cores: 4, mem_gb: 16, free_gb: 8, load: 50 } : { cores: 16, mem_gb: 32, free_gb: 12, load: 0 }) })))) }
const writeCtl = (site, runMs = {}) => { for (const i of [rig.main, rig.comp]) fs.writeFileSync(path.join(i.dir, 'brain-ctl.json'), JSON.stringify({ site: site.base, runMs: runMs[i.name] || 400, girls: Object.fromEntries([...girls].map(([g, id]) => [id, g])) })) }
// ---- the adapter
const girls = new Map()    // girl number -> profile id (made once on Main, copied to the Companion)
export async function makeRealBrain({ site } = {}) {
  if (!rig) await buildRig()
  rig.site = site; rig.stopped = false; rig.runMs = {}; writeCtl(site)
  const inst = (n) => (n === 'Main' ? rig.main : n === 'Comp' ? rig.comp : n === 'Fast' ? { name: 'Fast', virtual: true } : null)
  const need = (n) => inst(n) || (() => { throw new NotBuilt(`a PC called "${n}" — the rig has Main, Comp and (power entry only) Fast`) })()
  const making = new Map()
  const ensureProfile = (g) => { if (!making.has(g)) making.set(g, makeProfile(g)); return making.get(g) }
  const makeProfile = async (g) => {
    if (girls.has(g)) return girls.get(g)
    const home = rig.main.alive ? rig.main : rig.comp
    const r = await (await fetch(`${home.url}/api/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: `TEST GIRL ${g}`, phone_number: `09110${g}`, passport_number: `EP${5550000 + Number(g)}` }) })).json()
    if (!r.id) throw new Error(`could not make profile ${g}: ${JSON.stringify(r)}`)
    girls.set(g, r.id); writeCtl(rig.site, rig.runMs)
    const other = home === rig.main ? rig.comp : rig.main
    for (let k = 0; k < 40 && other.alive; k++) { if (rowsOfProfiles(other).includes(r.id)) break; await sleep(1000) }
    return r.id
  }
  const rowsOfProfiles = (i) => { const d = db(i); try { return d.prepare('select id from profiles').all().map(x => x.id) } finally { d.close() } }
  return {
    name: 'real', leaseMs: 105000, timeoutMs: 1500000, slackMs: 150000,   // (the Companion's gate: Main silent 45 s, or 120 s since its own start)
      // (Umar: a dead PC's run is failed ~105 s after it died)
    async addPC(name, o = {}) { const i = need(name); rig.runMs[name] = o.runMs; (rig.power ||= {})[name] = o.strength ?? 1; writeCtl(site, rig.runMs); writePower(); return i },
    async enqueue(name, girl, { wf = 'musaned_check_chosen', pinned = false } = {}) {
      const i = need(name), pid = await ensureProfile(girl)
      const r = await (await fetch(`${i.url}/api/profiles/${pid}/automations/${wf}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anyStep: true, ...(pinned ? { pinned: true } : {}) }) })).json()
      if (!r.runId) throw new Error(`the run was not queued on ${name}: ${JSON.stringify(r)}`)
      return r.runId
    },
    async profileId(girl) { return girls.get(girl) },
    async off(name) { await stopProc(need(name)) },
    async on(name) { const i = need(name); rig.start(i); await waitHealth(i.port) },
    // Umar: ADAL_BLOCK_PEERS=<file>, one address (or PC id) per line, in each instance: the claims and the PC copying treat them as unreachable.
    cut() { for (const [me, other] of [[rig.main, rig.comp], [rig.comp, rig.main]]) fs.writeFileSync(path.join(me.dir, 'block-peers.txt'), [`http://127.0.0.1:${other.port}`, `http://${HOST}:${other.port}`].join('\n') + '\n') },
    heal() { for (const i of [rig.main, rig.comp]) fs.writeFileSync(path.join(i.dir, 'block-peers.txt'), '# open\n') },
    async prepare(list) { for (const g of list) await ensureProfile(g) },
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
    async close() { await this.shutdown() },   // every scenario gets a fresh pair of servers (a leftover row or restart would colour the next one)
    async shutdown() { if (!rig) return; for (const i of [rig.main, rig.comp]) await stopProc(i); fs.rmSync(rig.root, { recursive: true, force: true }); rig = null; girls.clear() },
  }
}
