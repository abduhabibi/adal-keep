/**
 * One fake PC of the release gate (scripts/release-gate.mjs): the real
 * copying between an agency's PCs — Adal Keep's own migrations on its own
 * database, the real SyncEngine and SyncNode (with their timers: push after a
 * change, a round at the start and every minute), the real /api/sync routes —
 * on an express app on 127.0.0.1:<port>. No browser, no robots, no WhatsApp,
 * no online copy, no UDP: nothing else of Adal Keep is started.
 *
 * Its folder (GATE_DIR): data.sqlite, SafeStorage/, uploads/ — as on a PC.
 * The gate drives it through /gate/* (only with GATE_TOKEN, only on 127.0.0.1):
 *   GET  /gate/state?pid=      the profile, the uploads (sha256), the PCs it reached
 *   POST /gate/profile         a new profile (as the app writes it: the app's knex)
 *   POST /gate/edit            {id, set} fields of a profile changed
 *   POST /gate/upload          {profile_id, name, b64} a document into uploads/<pid>/<field>/ + its rows
 *   POST /gate/snapshot        {to} this database whole into another PC's folder (a joining PC's first copy)
 * A joining PC comes in on POST /api/sync/join with the gate's token (in place of the main PC's number).
 */
import fs from 'fs'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const env = (k, d) => process.env[k] ?? d
const DIR = path.resolve(env('GATE_DIR'))
const ROOT = path.resolve(env('GATE_ROOT', path.dirname(DIR)))
const PORT = Number(env('GATE_PORT'))
const NAME = env('GATE_NAME', 'PC')
const SLOT = Number(env('GATE_SLOT', '1'))
const PCID = env('GATE_PCID')
const KEY = env('GATE_KEY')
const TOKEN = env('GATE_TOKEN')
const MAIN = env('GATE_MAIN_URL', '')
const CLAIM = env('GATE_CLAIM') === '1'
if (!DIR || !PORT || !/^[0-9a-f]{12}$/.test(PCID || '') || !KEY || !TOKEN) { console.error('sync-pc: missing GATE_* settings'); process.exit(2) }
// Whatever Adal Keep's modules look for stays inside this PC's folder.
process.env.ADAL_SYNC_ID = path.join(DIR, 'sync-id.json')
process.env.ADAL_PC_ACCESS_FILE = path.join(DIR, 'pc-access.json')
process.env.SQLITE_PATH = path.join(DIR, 'data.sqlite')

const { default: knex } = await import('knex')
const { default: express } = await import('express')
const { SyncClient, setSlot } = await import('../../src/services/sync/ids.js')
const { SyncEngine } = await import('../../src/services/sync/engine.js')
const { SyncNode } = await import('../../src/services/sync/node.js')
const { createSyncRouter } = await import('../../src/routes/sync.js')

fs.mkdirSync(path.join(DIR, 'SafeStorage'), { recursive: true })
fs.mkdirSync(path.join(DIR, 'uploads'), { recursive: true })
const FILE = path.join(DIR, 'data.sqlite')
const pool = (busy) => ({ min: 1, max: 1, afterCreate(conn, done) { conn.run('PRAGMA journal_mode = WAL;'); conn.run(`PRAGMA busy_timeout = ${busy};`); conn.run('PRAGMA synchronous = NORMAL;', () => done(null, conn)) } })
setSlot(SLOT)
// The app's knex (new rows get ids no other PC makes) and the engine's own plain one, as on a PC (sync/index.js).
const app = knex({ client: SyncClient, connection: { filename: FILE }, useNullAsDefault: true, syncSlot: SLOT, pool: pool(8000) })
await app.migrate.latest({ directory: path.join(BACKEND, 'src', 'migrations'), tableName: 'knex_migrations', loadExtensions: ['.js'] })
const db = knex({ client: 'sqlite3', connection: { filename: FILE }, useNullAsDefault: true, pool: pool(15000) })
const quiet = { info() {}, log() {}, warn: (...a) => console.warn(`[${NAME}]`, ...a), error: (...a) => console.error(`[${NAME}]`, ...a) }
const engine = new SyncEngine(db, { pcId: PCID, slot: SLOT, log: quiet })
await engine.init()

let node = null
const web = express()
web.use(express.json({ limit: '20mb' }))
const gated = (req, res, next) => (req.headers['x-gate-token'] === TOKEN ? next() : res.status(401).json({ error: 'gate token' }))
web.use('/api', createSyncRouter({
  getNode: () => node,
  here: (req) => req.headers['x-gate-token'] === TOKEN,
  admitted: (req) => (req.headers['x-gate-token'] === TOKEN ? { id: `gate-${crypto.randomBytes(3).toString('hex')}`, name: 'gate' } : null),
}))
const server = http.createServer(web)
await new Promise((ok) => { server.once('error', (e) => { console.error(`port ${PORT} on 127.0.0.1: ${e.code === 'EADDRINUSE' ? 'already in use' : e.message}`); process.exit(3) }); server.listen(PORT, '127.0.0.1', ok) })
node = new SyncNode({ engine, safeDir: path.join(DIR, 'SafeStorage'), uploadsDir: path.join(DIR, 'uploads'), key: KEY, port: PORT, name: NAME, version: 'gate', addresses: () => ['127.0.0.1'], mainURL: () => MAIN, log: quiet, licenceKey: 'gate' })
await node.start({ timers: true, claim: CLAIM })

const now = () => new Date().toISOString()
const stamp = () => engine.stampNow()   // (Adal Keep does this 0.4 s after a change: changes.js → sync/index.js)
const fail = (res, e) => res.status(500).json({ error: e.message })
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

web.get('/gate/state', gated, async (req, res) => {
  try {
    const pid = req.query.pid
    const profile = pid ? (await app('profiles').where({ id: pid }).first()) || null : null
    const files = pid ? await app('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id').where('profile_fields.profile_id', pid).select('files.path', 'files.content_hash') : []
    const uploads = files.map(f => { const p = path.join(DIR, ...String(f.path).split('/')); return { path: f.path, want: f.content_hash, have: fs.existsSync(p) ? sha(p) : null } })
    const pcs = (await db.raw('SELECT pc_id, name, slot FROM sync_pcs ORDER BY slot')).map(r => ({ ...r, reached: r.pc_id === PCID ? true : !!node.peerState.get(r.pc_id)?.ok, error: node.peerState.get(r.pc_id)?.error || null }))
    res.json({ name: NAME, pc_id: PCID, main: node.roles.isMain(), holder: node.roles.holder(), profile, uploads, pcs, vector: await engine.vector(), rss: process.memoryUsage().rss })
  } catch (e) { fail(res, e) }
})
web.post('/gate/profile', gated, async (req, res) => {
  try {
    const b = req.body || {}
    const [row] = await app('profiles').insert({ full_name: b.full_name, passport_number: b.passport_number, status: 'new', notes: b.notes || '', created_at: now(), updated_at: now() }).returning('id')
    await stamp()
    res.json({ id: row?.id ?? row })
  } catch (e) { fail(res, e) }
})
web.post('/gate/edit', gated, async (req, res) => {
  try { await app('profiles').where({ id: req.body.id }).update({ ...req.body.set, updated_at: now() }); await stamp(); res.json({ ok: true }) } catch (e) { fail(res, e) }
})
web.post('/gate/upload', gated, async (req, res) => {
  try {
    const b = req.body || {}
    const buf = Buffer.from(String(b.b64 || ''), 'base64')
    const [pf] = await app('profile_fields').insert({ profile_id: b.profile_id, field_template_id: null, name: 'photo', data_type: 'file', value_text: '' }).returning('id')
    const fieldId = pf?.id ?? pf
    // As the app's upload: uploads/<profileId>/<fieldId>/<name>, a files row naming it (files.path).
    const rel = `uploads/${b.profile_id}/${fieldId}/${path.basename(String(b.name))}`
    const abs = path.join(DIR, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, buf)
    const hash = crypto.createHash('sha256').update(buf).digest('hex')
    await app('files').insert({ profile_field_id: fieldId, original_name: b.name, path: rel, mimetype: 'image/jpeg', size: buf.length, content_hash: hash })
    await stamp()
    res.json({ path: rel, sha256: hash })
  } catch (e) { fail(res, e) }
})
web.post('/gate/snapshot', gated, async (req, res) => {
  try {
    const to = path.resolve(String(req.body?.to || ''))
    if (!to.startsWith(ROOT + path.sep) || fs.existsSync(to)) return res.status(400).json({ error: 'bad target' })
    await db.raw('VACUUM INTO ?', [to])
    res.json({ ok: true })
  } catch (e) { fail(res, e) }
})

const stop = async () => { try { node.stop(); server.closeAllConnections?.(); server.close(); await app.destroy(); await db.destroy() } catch {} process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('end', stop)   // the gate went away: so does this PC
process.stdin.resume()
console.log(`READY ${PORT}`)
