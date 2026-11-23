/**
 * whatsappOffHere.test.js — a test or isolated copy never signs WhatsApp in (asked on
 * 2026-11-23: the phone test started a real WhatsApp session and link code from a scratch copy).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.ACCOUNT_VAULT_KEY = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-off-')), 'k')
const W = await import('../src/services/whatsapp.js')

test('off in an isolated copy and with ADAL_WHATSAPP=0; on otherwise', () => {
  assert.equal(W.whatsappAllowed({ ADAL_ISOLATED: '1' }), false)
  assert.equal(W.whatsappAllowed({ ADAL_WHATSAPP: '0' }), false)
  assert.equal(W.whatsappAllowed({}), true)
})

test('an isolated copy: connect, link code and the sign-in window start nothing', async () => {
  process.env.ADAL_ISOLATED = '1'
  try {
    const st = await W.connect(null, 'test-off')
    assert.equal(st.status, 'off')
    assert.match(st.error, /off on this copy/)
    await assert.rejects(W.linkByCode(null, 'test-off', '251911223344'), /off on this copy/)
    assert.equal((await W.openWeb(null, 'test-off')).status, 'off')
  } finally { delete process.env.ADAL_ISOLATED }
})
