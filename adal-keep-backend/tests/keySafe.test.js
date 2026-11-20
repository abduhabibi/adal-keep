import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-keys-'))
process.env.ACCOUNT_VAULT_KEY = path.join(dir, 'account-vault.key')
process.env.ADAL_KEYS_OUTSIDE = path.join(dir, 'outside')
process.env.SECRETS_PATH = path.join(dir, 'secrets.enc')

const V = await import('../src/services/accountVault.js')
const K = await import('../src/services/keySafe.js')

// A database stand-in: one portal password, sealed with the key of its time.
function fakeDb(sealed) {
  return { schema: { hasTable: async (t) => t === 'musaned_accounts' }, raw: async () => [{ sealed_value: sealed }] }
}

test('the right key: nothing changes, and a copy goes outside the install folder', async () => {
  const sealed = V.seal('pw-1')
  assert.equal(await K.guardVaultKey(fakeDb(sealed), { online: async () => null }), 'ok')
  assert.equal(K.outsideKeys().length, 1)
})

test('a wrong key here: the kept copy that opens the passwords comes back, the wrong one is kept beside', async () => {
  const good = V.vaultKey()
  const sealed = V.seal('pw-2')
  // The key file replaced by another one (a reinstall made a new key).
  fs.writeFileSync(process.env.ACCOUNT_VAULT_KEY, crypto.randomBytes(32).toString('base64'))
  V.stageVaultKey(fs.readFileSync(process.env.ACCOUNT_VAULT_KEY, 'utf8')); V.applyStagedVaultKey()
  assert.notEqual(V.vaultKey(), good)
  assert.equal(await K.guardVaultKey(fakeDb(sealed), { online: async () => null }), 'restored:this PC (outside the install folder)')
  assert.equal(V.vaultKey(), good)
  assert.equal(V.open(sealed), 'pw-2')
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('account-vault.key.before-restore-')))
})

test('no copy on this PC: the one in Supabase is used', async () => {
  const good = V.vaultKey()
  const sealed = V.seal('pw-3')
  fs.rmSync(process.env.ADAL_KEYS_OUTSIDE, { recursive: true, force: true })
  V.stageVaultKey(crypto.randomBytes(32).toString('base64')); V.applyStagedVaultKey()
  fs.rmSync(process.env.ADAL_KEYS_OUTSIDE, { recursive: true, force: true })
  assert.equal(await K.guardVaultKey(fakeDb(sealed), { online: async () => good }), 'restored:Supabase')
  assert.equal(V.open(sealed), 'pw-3')
})

test('no kept key opens them: nothing is replaced', async () => {
  const sealed = V.seal('pw-4')
  const before = V.vaultKey()
  V.stageVaultKey(crypto.randomBytes(32).toString('base64')); V.applyStagedVaultKey()
  fs.rmSync(process.env.ADAL_KEYS_OUTSIDE, { recursive: true, force: true })
  const now = V.vaultKey()
  assert.equal(await K.guardVaultKey(fakeDb(sealed), { online: async () => null }), 'missing')
  assert.equal(V.vaultKey(), now)
  assert.notEqual(now, before)
})

test('the documents key: kept here, and a different one before it is never dropped', () => {
  K.keepFileKey('ag-1', 'key-A')
  assert.equal(K.keptFileKey('ag-1'), 'key-A')
  K.keepFileKey('ag-1', 'key-B')
  assert.equal(K.keptFileKey('ag-1'), 'key-B')
  const store = JSON.parse(fs.readFileSync(process.env.SECRETS_PATH, 'utf8'))
  assert.ok(Object.keys(store).some(k => k.startsWith('docs_file_key_before:ag-1:')))
})

test('the key file gone at start: the copy outside comes back before a new one is made', async () => {
  const good = V.vaultKey()
  K.copyVaultKeyOutside(good)
  fs.rmSync(process.env.ACCOUNT_VAULT_KEY)
  const fresh = await import(`../src/services/accountVault.js?again=${Date.now()}`)
  assert.equal(fresh.vaultKey(), good)
})
