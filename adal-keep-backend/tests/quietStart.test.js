// "When ever I open Adal Keep the whole PC gets busy" (an employee, 2026-11-25). What ran by itself
// after a morning opening: the whole database copied about 10 s in, ~3,000 pages made for the online
// copy 45 s in (each a false "viewed" line), every list again each minute with nothing changed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-quiet-'))
process.env.ADAL_NO_SOUND = '1'
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_KEYS_OUTSIDE = path.join(tmp, 'keys')
process.env.ADAL_BACKUP_STATE = path.join(tmp, 'backup-state.json')
process.env.ADAL_BACKUP_SAFE = path.join(tmp, 'Safe')
process.env.ADAL_CHAT_SESSION_FILE = path.join(tmp, 'chat.json')
process.env.ADAL_MEDICAL_READ = path.join(tmp, 'medical-read.json')
const HOUR = 3600e3, MIN = 60e3

// This PC's own pages, and the online service: both stand-ins.
let pages = [], online = []
const serve = (fn) => new Promise(ok => { const s = http.createServer(fn).listen(0, '127.0.0.1', () => ok(s)); s.unref() })
const local = await serve((q, s) => { pages.push({ url: q.url.replace('/api', ''), cloud: q.headers['x-adal-cloud'] }); s.setHeader('content-type', 'application/json'); s.end('{}') })
const cloud = await serve((q, s) => {
  q.resume(); online.push(`${q.method} ${q.url.split('?')[0]}`); s.setHeader('content-type', 'application/json')
  s.end(q.url.startsWith('/auth/') ? JSON.stringify({ access_token: 'x', refresh_token: 'y', expires_in: 3600, user: { id: 'agency-1' } }) : q.method === 'GET' ? '[]' : '{}')
})
process.env.PORT = String(local.address().port)
process.env.SUPABASE_URL = `http://127.0.0.1:${cloud.address().port}`
process.env.SUPABASE_ANON_KEY = 'dummy'
const { default: knex } = await import('knex')
const U = await import('../src/services/userUploads.js')
const B = await import('../src/services/telegramBackup.js')

test('a morning opening: the evening\'s backup is followed by the next one 15 minutes in, not 10 seconds', () => {
  const T0 = Date.now(), lastFull = new Date(T0 - 14 * HOUR).toISOString()
  const due = (ms) => B.fullBackupDue({ now: T0 + ms, bootAt: T0, lastFull, lastRun: lastFull, robots: 0 })
  assert.equal(due(10e3), false)
  assert.equal(due(5 * MIN), false)
  assert.equal(due(15 * MIN), true)
})

test('the online copy: lists only when something changed, the safety sweep in slices and never just after opening', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  try {
    await db.schema.createTable('cloud_sync', t => { t.string('key').primary(); t.string('hash'); t.string('at') })
    for (const t of ['profiles', 'brokers', 'cv_templates', 'settings']) await db.schema.createTable(t, x => { x.increments('id'); x.string('key'); x.string('value'); x.string('updated_at') })
    await db.schema.createTable('automation_queue', t => { t.increments('id'); t.integer('profile_id'); t.string('updated_at') })
    for (let i = 1; i <= 4; i++) await db('profiles').insert({ updated_at: '2020-01-01 00:00:00' })
    await db('cloud_sync').insert([{ key: 'agency', hash: 'agency-1' }, { key: 'sweep:full', hash: String(Date.now() - 14 * HOUR) }, { key: 'sweep:at', hash: String(Date.now() - 60e3) }])
    const C = await import('../src/services/cloudSync.js')
    const round = async () => { pages = []; await C.syncNow(db); return pages.map(p => p.url) }
    const opened = await round()
    assert.ok(opened.includes('/profiles'), 'the first round: the lists')
    assert.ok(!opened.some(u => /^\/profiles\/\d/.test(u)), 'no sweep just after opening')
    assert.ok(pages.every(p => p.cloud === '1'), 'told apart from a person (no "viewed" line)')
    const quiet = await round()
    assert.ok(!quiet.includes('/profiles') && !quiet.includes('/dashboard') && quiet.length <= 6, `nothing changed: ${quiet.join(" ")}`)
    C.noteChanged(['audit_log', 'sync_pcs'])
    assert.ok(!(await round()).includes('/profiles'), 'bookkeeping is not a change')
    C.noteChanged(['tasks'])
    assert.ok((await round()).includes('/dashboard'), 'a change: the lists with the next round')
    C._openedFor(11 * MIN)
    const swept = []
    for (let i = 0; i < 8 && !swept.includes('/profiles/4/days'); i++) swept.push(...await round())   // (slices: a busy PC needs a few rounds)
    for (let i = 0; i < 4 && Date.now() - Number((await db('cloud_sync').where('key', 'sweep:full').first()).hash) >= 5 * MIN; i++) await round()
    assert.ok([1, 2, 3, 4].every(i => swept.includes(`/profiles/${i}`)), 'ten minutes in: the sweep')
    assert.ok(Date.now() - Number((await db('cloud_sync').where('key', 'sweep:full').first()).hash) < 5 * MIN, 'and it is marked done')
    assert.ok(!(await round()).some(u => /^\/profiles\/\d/.test(u)), 'not again')
  } finally { await db.destroy() }
})

test('a person\'s click comes first; an open window\'s own looks and the online copy\'s reading do not count', async () => {
  let now = 1e6
  U._setClock(() => now)
  try {
    U._reset()
    U.notePerson({ path: '/api/health', headers: {} }); U.notePerson({ path: '/api/profiles/3', headers: { 'x-adal-cloud': '1' } })
    assert.equal(U.personBusy(), false)
    U.notePerson({ path: '/api/profiles/3', headers: {} })
    assert.equal(U.personBusy(), true)
    now += U.CLICK_MS + 1
    assert.equal(U.personBusy(), false)
    U.notePerson({ path: '/api/profiles/3', headers: {} })
    const t = Date.now()
    await U.afterClicks({ max: 300, every: 100 })
    assert.ok(Date.now() - t >= 250 && Date.now() - t < 2000, 'slowed, never stopped')
  } finally { U._setClock(); U._reset() }
})

test('the online copy\'s own reading of a profile is not a "viewed" line; a person\'s and a phone\'s are', async () => {
  const A = await import('../src/services/audit.js')
  const seen = []
  const go = (headers) => { let ended = false; A.auditViews({ method: 'GET', path: '/profiles/7', get: (h) => headers[h], headers, app: { locals: {} } }, { on: () => { ended = true } }, () => {}); seen.push(ended) }
  go({ 'x-adal-cloud': '1' }); go({}); go({ 'x-adal-cloud': '1', 'x-adal-who': 'Abebe%20(phone)' })
  assert.deepEqual(seen, [false, true, true])
})

test('a new day\'s profile rows: one write for many, all kept; only what changed later', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  try {
    await db.schema.createTable('profile_days', t => { t.increments('id'); t.integer('profile_id'); t.string('day'); t.text('data'); t.string('updated_at'); t.unique(['profile_id', 'day']) })
    const { keepDays } = await import('../src/services/profileDays.js')
    let writes = 0
    db.on('query', (q) => { if (/^insert/i.test(q.sql)) writes++ })
    const list = Array.from({ length: 120 }, (_, i) => ({ profile_id: i + 1, stage: 'a', steps: {}, notes: {} }))
    assert.equal(await keepDays(db, list), 120)
    assert.equal(Number((await db('profile_days').count({ n: '*' }).first()).n), 120)
    assert.ok(writes <= 3, `${writes} writes`)
    list[4].stage = 'b'
    assert.equal(await keepDays(db, list), 1)
  } finally { await db.destroy() }
})

test('a medical record is read once, not at every start', async () => {
  const M = await import('../src/services/medicalValidity.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  try {
    await db.schema.createTable('profiles', t => { t.increments('id'); t.string('status'); t.string('medical_valid_from'); t.string('medical_valid_until') })
    await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
    await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('path'); t.string('mimetype'); t.integer('size') })
    const pdf = path.join(tmp, 'm.pdf'); fs.writeFileSync(pdf, 'not a pdf')
    await db('profiles').insert({ status: 'x' }); await db('profile_fields').insert({ profile_id: 1, name: 'Medical Report' })
    await db('files').insert({ profile_field_id: 1, path: pdf, mimetype: 'application/pdf', size: 9 })
    await M.backfillMedical(db)
    const first = fs.statSync(process.env.ADAL_MEDICAL_READ).mtimeMs
    let read = 0
    const real = fs.readFileSync
    fs.readFileSync = (f, ...a) => { if (f === pdf) read++; return real(f, ...a) }
    try { await M.backfillMedical(db) } finally { fs.readFileSync = real }
    assert.equal(read, 0)
    assert.equal(fs.statSync(process.env.ADAL_MEDICAL_READ).mtimeMs, first)
    await db('files').update({ size: 10 })   // another record in its place
    await M.backfillMedical(db)
    assert.notEqual(fs.statSync(process.env.ADAL_MEDICAL_READ).mtimeMs, first)
  } finally { await db.destroy() }
})
