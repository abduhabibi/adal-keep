// The database backup: a whole copy, then only the changed pages; a restore
// puts them together into exactly the database that was backed up.
// Everything runs on a throwaway database with Telegram faked in memory.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-bk-'))
process.env.SQLITE_PATH = path.join(dir, 'data.sqlite')
process.env.ADAL_BACKUP_STATE = path.join(dir, 'backup-state.json')
process.env.SECRETS_PATH = path.join(dir, 'secrets.enc')
process.env.ADAL_BACKUP_SAFE = path.join(dir, 'SafeStorage')
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
// No cloud: the chat and the agency's online rows are never asked (nor their sign-in file written).
process.env.SUPABASE_URL = ''
process.env.SUPABASE_ANON_KEY = ''
process.env.TELEGRAM_STORAGE_CHAT = '-100'

// Telegram, in memory.
const store = new Map()
let uploads = 0
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (!u.startsWith('https://api.telegram.org/')) throw new Error('only Telegram is faked here')
  const json = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })
  if (u.includes('/file/bot')) { const id = u.split('/').pop(); return { ok: true, status: 200, arrayBuffer: async () => store.get(id) } }
  if (u.endsWith('/sendDocument')) {
    const blob = opts.body.get('document')
    const id = `f${store.size + 1}`
    store.set(id, await blob.arrayBuffer()); uploads++
    return json({ document: { file_id: id } })
  }
  if (u.endsWith('/getFile')) return json({ file_path: JSON.parse(opts.body).file_id })
  return json({})
}

const { default: knex } = await import('knex')
const db = knex({ client: 'sqlite3', connection: { filename: process.env.SQLITE_PATH }, useNullAsDefault: true })
const { setSecret } = await import('../src/services/secretStore.js')
const bk = await import('../src/services/telegramBackup.js')
setSecret('backup_password', 'a-test-password-123')

await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.text('notes') })
const rows = Array.from({ length: 3000 }, (_, i) => ({ full_name: `Person ${i}`, notes: `note ${i} `.repeat(40) }))
for (let i = 0; i < rows.length; i += 200) await db('profiles').insert(rows.slice(i, i + 200))

const state = () => JSON.parse(fs.readFileSync(process.env.ADAL_BACKUP_STATE, 'utf8'))
async function restored() {
  const index = JSON.parse(zlib.gunzipSync(bk.unlock(Buffer.from(store.get(state().index_file_id)), 'a-test-password-123')).toString())
  const raw = await bk.databaseFromIndex(index, async (set) => bk.unlock(Buffer.concat(set.parts.map(id => Buffer.from(store.get(id)))), 'a-test-password-123'))
  const file = path.join(dir, `restored-${Date.now()}.sqlite`)
  fs.writeFileSync(file, raw)
  const copy = knex({ client: 'sqlite3', connection: { filename: file }, useNullAsDefault: true })
  try { return { count: Number((await copy('profiles').count({ n: '*' }).first()).n), first: (await copy('profiles').where('id', 1).first()).full_name, sets: index.sets.map(s => s.type) } }
  finally { await copy.destroy() }
}

test('first run: a whole zstd copy; restore opens it', { skip: !bk.HAS_ZSTD }, async () => {
  const r = await bk.runBackup(db, { force: true })
  assert.equal(r.ok, true)
  const back = await restored()
  assert.deepEqual(back.sets, ['dbz'])
  assert.equal(back.count, 3000)
})

test('a change: only its pages go up; restore has the change', { skip: !bk.HAS_ZSTD }, async () => {
  await db('profiles').where('id', 1).update({ full_name: 'Changed name' })
  await db('profiles').insert({ full_name: 'New person', notes: 'x' })
  const before = uploads
  await bk.runBackup(db, { force: true })
  const delta = state().sets.find(s => s.type === 'dbz-delta')
  assert.ok(delta, 'a changes set was sent')
  assert.ok(delta.pages < 20, `only a few pages (${delta.pages})`)
  assert.equal(uploads - before, 2, 'one changes piece and the index')
  const back = await restored()
  assert.deepEqual(back.sets, ['dbz', 'dbz-delta'])
  assert.equal(back.count, 3001)
  assert.equal(back.first, 'Changed name')
})

test('nothing changed: nothing is uploaded', { skip: !bk.HAS_ZSTD }, async () => {
  const before = uploads
  const r = await bk.runBackup(db, { force: true })
  assert.equal(r.unchanged, true)
  assert.equal(uploads, before)
})

test('applyDelta grows and shrinks the file to the new length', () => {
  const ps = 4, base = Buffer.from('aaaabbbbcccc'), now = Buffer.from('aaaaXbbbccccdd')
  const { delta } = bk.makeDelta(now, ps, bk.pageHashes(base, ps))
  assert.deepEqual(bk.applyDelta(base, delta), now)
  const shorter = Buffer.from('aaaabb')
  assert.deepEqual(bk.applyDelta(base, bk.makeDelta(shorter, ps, bk.pageHashes(base, ps)).delta), shorter)
})

test.after(async () => { await db.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
