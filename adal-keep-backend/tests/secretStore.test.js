import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'))
process.env.SECRETS_PATH = path.join(dir, 's.enc')
process.env.ACCOUNT_VAULT_KEY = path.join(dir, 'k')
const { setSecret, getSecret, moveSecretsToVault } = await import('../src/services/secretStore.js')

// The old way: locked with this machine's name and network card.
function oldBlob(text) {
  const mac = Object.values(os.networkInterfaces()).flat().find(i => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')?.mac || ''
  const key = crypto.createHash('sha256').update('adal-keep-secret-store-v1|' + [os.hostname(), os.platform(), os.arch(), mac].join('|')).digest()
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}

test('a secret still opens on another machine', () => {
  setSecret('a', 'one')
  const name = os.hostname
  os.hostname = () => 'another-pc'
  try { assert.equal(getSecret('a'), 'one') } finally { os.hostname = name }
})

test('secrets locked to this machine move over and then survive the move', () => {
  fs.writeFileSync(process.env.SECRETS_PATH, JSON.stringify({ old: oldBlob('two') }))
  assert.equal(getSecret('old'), 'two')
  assert.equal(moveSecretsToVault(), 1)
  assert.equal(moveSecretsToVault(), 0)
  const name = os.hostname
  os.hostname = () => 'another-pc'
  try { assert.equal(getSecret('old'), 'two') } finally { os.hostname = name }
})
