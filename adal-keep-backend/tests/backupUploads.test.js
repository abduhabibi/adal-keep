// A restore onto a brand-new PC (2026-11-27, the recovery test): the photos added in the window (uploads/) come back
// byte for byte, and the agency's backup key still opens on the new PC afterwards. Telegram in memory.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-bkup-'))
Object.assign(process.env, {
  SQLITE_PATH: path.join(dir, 'data.sqlite'), ADAL_BACKUP_STATE: path.join(dir, 'backup-state.json'), SECRETS_PATH: path.join(dir, 'secrets.enc'),
  ADAL_BACKUP_SAFE: path.join(dir, 'SafeStorage'), ADAL_UPLOADS_DIR: path.join(dir, 'uploads'), ADAL_BACKUP_TMP: path.join(dir, 'backup-tmp'), ACCOUNT_VAULT_KEY: path.join(dir, 'account-vault.key'),
  TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_STORAGE_CHAT: '-100', SUPABASE_URL: '', SUPABASE_ANON_KEY: '',
})
const store = new Map()
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), json = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })
  if (!u.startsWith('https://api.telegram.org/')) throw new Error('only Telegram is faked here')
  if (u.includes('/file/bot')) { const id = u.split('/').pop(); return { ok: true, status: 200, arrayBuffer: async () => store.get(id) } }
  if (u.endsWith('/sendDocument')) { const id = `f${store.size + 1}`; store.set(id, await opts.body.get('document').arrayBuffer()); return json({ document: { file_id: id } }) }
  if (u.endsWith('/getFile')) return json({ file_path: JSON.parse(opts.body).file_id })
  return json({})
}
const { default: knex } = await import('knex')
const db = knex({ client: 'sqlite3', connection: { filename: process.env.SQLITE_PATH }, useNullAsDefault: true })
const bk = await import('../src/services/telegramBackup.js')
const { getSecret } = await import('../src/services/secretStore.js')
test.after(async () => { await db.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })

const photo = (n) => path.join(dir, 'uploads', `17${n}`, '5', `photo-${n}.jpg`)
test("the window's photos are in the backup and come back byte for byte; thumbnails and odd names are not", async () => {
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name') })
  await db('profiles').insert({ full_name: 'TEST GIRL' })
  const want = {}
  for (const n of [1, 2]) { fs.mkdirSync(path.dirname(photo(n)), { recursive: true }); want[n] = crypto.randomBytes(5000); fs.writeFileSync(photo(n), want[n]) }
  fs.mkdirSync(path.join(dir, 'uploads', 'thumbnails'), { recursive: true }); fs.writeFileSync(path.join(dir, 'uploads', 'thumbnails', 'thumb_x.jpg'), 'x')
  bk.ensureBackupKey()
  const key = getSecret('backup_password')
  assert.equal((await bk.runBackup(db, { force: true })).ok, true)
  const st = JSON.parse(fs.readFileSync(process.env.ADAL_BACKUP_STATE, 'utf8'))
  assert.deepEqual(Object.keys(st.sent).sort(), ['uploads/171/5/photo-1.jpg', 'uploads/172/5/photo-2.jpg'])
  // The PC is lost: its files are gone.
  fs.rmSync(path.join(dir, 'uploads'), { recursive: true, force: true })
  const index = Buffer.from(store.get(st.index_file_id))
  const r = await bk.restoreFrom(index, { password: key })
  assert.equal(r.ok, true); assert.equal(r.files, 2); assert.equal(r.key_carried, true)
  for (const n of [1, 2]) assert.ok(fs.readFileSync(photo(n)).equals(want[n]), `photo ${n} byte for byte`)
})

test('ADAL_BACKUP_UPLOADS=0: as before (SafeStorage only)', async () => {
  process.env.ADAL_BACKUP_UPLOADS = '0'
  try {
    fs.mkdirSync(path.join(dir, 'uploads', '9', '9'), { recursive: true }); fs.writeFileSync(path.join(dir, 'uploads', '9', '9', 'new.jpg'), 'n')
    await new Promise(r => setTimeout(r, 10))
    await bk.runBackup(db, { force: true })
    const st = JSON.parse(fs.readFileSync(process.env.ADAL_BACKUP_STATE, 'utf8'))
    assert.ok(!st.sent['uploads/9/9/new.jpg'])
  } finally { delete process.env.ADAL_BACKUP_UPLOADS }
})
