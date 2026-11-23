// The agency's backup key in the cloud: sealed to Adal's recovery key (flag ADAL_BACKUP_SEAL).
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'

const S = () => import('../src/services/backupSeal.js')
const pair = () => {
  const k = crypto.generateKeyPairSync('x25519')
  return { pub: k.publicKey.export({ type: 'spki', format: 'pem' }), priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

test('a sealed key opens only with the private key, and each seal is different', async () => {
  const s = await S(), a = pair(), b = pair()
  const one = s.seal('agency-backup-key', a.pub), two = s.seal('agency-backup-key', a.pub)
  assert.notEqual(one, two)
  assert.equal(s.unseal(one, a.priv), 'agency-backup-key')
  assert.throws(() => s.unseal(one, b.priv))
  assert.ok(!one.includes('agency-backup-key'))
})
test('a changed sealed key is refused', async () => {
  const s = await S(), a = pair()
  const parts = s.seal('k', a.pub).split('.'); parts[4] = Buffer.from('xx').toString('base64url')
  assert.throws(() => s.unseal(parts.join('.'), a.priv))
})
test('flag off: the cloud row is as before; flag on: the plain key is gone', async () => {
  const s = await S()
  const row = { file_id: 'f1', key: 'plain-key', at: 'now' }
  delete process.env.ADAL_BACKUP_SEAL
  assert.deepEqual(s.forCloud(row), row)
  process.env.ADAL_BACKUP_SEAL = '1'
  try {
    const out = s.forCloud(row)
    assert.equal(out.key, null); assert.equal(out.file_id, 'f1')
    assert.equal(s.unseal(out.key_sealed, s.loadPrivate ? crypto.createPrivateKey(process.env.ADAL_ESCROW_KEY ? s.loadPrivate() : s.loadPrivate()).export({ type: 'pkcs8', format: 'pem' }) : ''), 'plain-key')
  } catch (e) {
    // The private half lives on Adal's PC only: on another machine just check the shape.
    if (e.code !== 'ENOENT') throw e
    const out = s.forCloud(row); assert.match(out.key_sealed, /^s1\./); assert.equal(out.key, null)
  } finally { delete process.env.ADAL_BACKUP_SEAL }
})
