// The address book (2026-11-26): a PC's word on where it is counts only signed with its agency's key.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'

const P = await import('../src/services/pcPresence.js')
const { agencyTag } = await import('../src/services/lanRelease.js')
const TAG = agencyTag('47040'), KEY = P.signKey('the agency backup key'), OTHER = P.signKey('another agency')
const mine = () => ['192.168.1.20']
const VECTOR = path.join(import.meta.dirname, '..', '..', 'adal-companion', 'testdata', 'presence', 'signed.txt')
const msg = (o = {}) => P.message({ tags: [TAG], pcId: 'aaaaaaaaaaaa', port: 4000, role: 'main', name: 'MAIN', ...o })

test('signed by our agency: taken, from one of the addresses it names only', () => {
  let t = 1_800_000_000_000
  const p = new P.Presence({ tags: () => [TAG], mine, key: () => KEY, now: () => t })
  const s = P.sign(msg(), KEY, ['192.168.1.5'], t)
  assert.equal(p.heard(s, '192.168.1.5').signed, true)
  assert.equal(p.heard(s, '192.168.1.66'), null, 'replayed from another PC')
  assert.equal(p.heard(P.sign(msg(), OTHER, ['192.168.1.66'], t), '192.168.1.66'), null, 'another agency with our number')
  assert.equal(p.heard(msg(), '192.168.1.66'), null, 'once signed, never unsigned again')
  assert.equal(p.heard(P.sign(msg(), KEY, ['192.168.1.5'], t - 120e3), '192.168.1.5'), null, 'older than the last one')
  t += 20 * 60e3
  assert.equal(p.heard(P.sign(msg(), KEY, ['192.168.1.5'], t - 16 * 60e3), '192.168.1.5'), null, 'a clock far off / an old copy')
  // It moved: the new address, at once.
  const e = p.heard(P.sign(msg(), KEY, ['192.168.1.3'], t), '192.168.1.3')
  assert.equal(e.ip, '192.168.1.3'); assert.equal(e.moved, '192.168.1.5')
  assert.ok(p.refused >= 5)
})

test('older programs and PCs without the key yet: as before; strict: signed only', () => {
  const p = new P.Presence({ tags: () => [TAG], mine, key: () => KEY })
  assert.equal(p.heard(msg({ pcId: 'bbbbbbbbbbbb' }), '192.168.1.7').signed, false)
  const nokey = new P.Presence({ tags: () => [TAG], mine })
  assert.equal(nokey.heard(P.sign(msg(), KEY, ['192.168.1.5']), '192.168.1.5').signed, false)
  process.env.ADAL_PRESENCE_STRICT = '1'
  try { assert.equal(new P.Presence({ tags: () => [TAG], mine, key: () => KEY }).heard(msg(), '192.168.1.7'), null) } finally { delete process.env.ADAL_PRESENCE_STRICT }
  // An older program reads it as ever.
  assert.equal(P.parse(P.sign(msg(), KEY, ['192.168.1.5'])).name, 'MAIN')
  process.env.ADAL_PRESENCE_SIGN = '0'
  try { assert.equal(P.sign(msg(), KEY), msg()) } finally { delete process.env.ADAL_PRESENCE_SIGN }
})

test('the same signature in the Companion (adal-companion presence_test.go reads this one)', () => {
  const v = P.sign(msg(), KEY, ['192.168.1.5', '10.0.0.5'], 1_800_000_000_000)
  const proof = `00112233445566778899aabbccddeeff aaaaaaaaaaaa ${P.proofOf(KEY, '00112233445566778899aabbccddeeff', 'aaaaaaaaaaaa')}`
  if (process.env.WRITE_VECTOR) { fs.writeFileSync(VECTOR, v + '\n'); fs.writeFileSync(VECTOR.replace('signed', 'proof'), proof + '\n') }
  assert.equal(fs.readFileSync(VECTOR, 'utf8').trim(), v)
  assert.equal(fs.readFileSync(VECTOR.replace('signed', 'proof'), 'utf8').trim(), proof)
  assert.equal(P.proofOf(null, 'x', 'y'), null)
})

test("this PC's address changes: said at once, the heartbeat online too", async () => {
  let addrs = ['192.168.1.5'], sent = [], moved = 0
  process.env.ADAL_ADDR_WATCH_MS = '50'
  const p = P.startPresence({ send: (t) => sent.push(t), ownId: () => 'aaaaaaaaaaaa', tags: () => [TAG], port: () => 4000, role: () => 'main', key: () => KEY, addrs: () => addrs, onMoved: () => moved++, log: {} })
  try {
    sent = []
    addrs = ['192.168.1.3']
    await new Promise(r => setTimeout(r, 120))
    assert.equal(moved, 1)
    assert.ok(sent.length >= 1 && P.parse(sent[0]).sig.addrs[0] === '192.168.1.3')
  } finally { P.stopPresence(); delete process.env.ADAL_ADDR_WATCH_MS }
})
