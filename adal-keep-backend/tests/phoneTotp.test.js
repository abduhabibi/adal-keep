// The phone shows the Musaned code itself (frontend src/lib/totp.js): it must
// be the very code the PC types (services/musanedTotp.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { totp } from '../src/services/musanedTotp.js'

const phoneFile = new URL('../../adal-keep-frontend/src/lib/totp.js', import.meta.url)

test('the phone and the PC make the same Musaned code', { skip: !fs.existsSync(phoneFile) && 'frontend not here' }, async () => {
  const phone = await import(phoneFile)
  const keys = [{ secret: 'JBSWY3DPEHPK3PXP' }, { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 6, period: 30, algorithm: 'SHA1' }]
  for (const k of keys) for (const at of [0, 59_000, 1_111_111_111_000, Date.now()]) {
    assert.equal(await phone.totp(k, at), totp(k, at))
  }
  const shown = await phone.codesOf({ 7: { secret: 'JBSWY3DPEHPK3PXP', label: 'x' } })
  assert.equal(shown[7].code, totp({ secret: 'JBSWY3DPEHPK3PXP' }))
})
