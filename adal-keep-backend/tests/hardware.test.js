// Hardware check (cores, RAM, 32/64-bit, link) and cloud Refine with its local fallback (2026-11-23).
import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'

process.env.ADAL_NO_NET_PROBE = '1'
const H = await import('../src/services/hardware.js')
const GB = 1024 ** 3

test('below 4 cores or 8 GB is weak, with the reasons', () => {
  const weak = H.measure({ cores: 2, totalmem: 6 * GB, arch: 'x64', env: {} })
  assert.equal(weak.weak, true)
  assert.equal(weak.reasons.length, 2)
  const ok = H.measure({ cores: 4, totalmem: 7.6 * GB, arch: 'x64', env: {} })   // an "8 GB" PC reports ~7.6
  assert.equal(ok.weak, false)
  assert.equal(H.measure({ cores: 8, totalmem: 16 * GB, arch: 'x64', env: {} }).weak, false)
})

test('32-bit and the network link are reported', () => {
  assert.equal(H.bitsOf('ia32', {}), 32)
  assert.equal(H.bitsOf('ia32', { PROCESSOR_ARCHITEW6432: 'AMD64' }), 64)
  const m = H.measure({ cores: 8, totalmem: 16 * GB, arch: 'ia32', env: {}, net: { rtt_ms: 900, mbps: 5, ok: 1 } })
  assert.equal(m.bits, 32); assert.equal(m.link, 'slow'); assert.equal(m.weak, true)
  assert.equal(H.linkOf({ rtt_ms: 80, mbps: 20, ok: 1 }), 'good')
  assert.equal(H.linkOf({ rtt_ms: 80, mbps: 20, ok: 0.4 }), 'unreliable')
  assert.equal(H.linkOf(null), 'unknown')
})

test('the robot gate is on by default, only under 4 cores, and only while a stronger office PC is on', () => {
  const two = H.measure({ cores: 2, totalmem: 16 * GB, arch: 'x64', env: {} })
  const four = H.measure({ cores: 4, totalmem: 16 * GB, arch: 'x64', env: {} })
  assert.equal(H.robotsBlocked(two, {}, { strongerOn: true }), true)
  assert.equal(H.robotsBlocked(two, {}, { strongerOn: false }), false)   // none on: it runs here (with a notice)
  assert.equal(H.robotsBlocked(two, { ADAL_HW_GATE: '0' }, { strongerOn: true }), false)
  assert.equal(H.robotsBlocked(four, {}, { strongerOn: true }), false)
  // Which office PCs count: another PC of 4+ cores on the office network.
  assert.equal(H.strongerPCOn([{ id: '', cores: 2 }]), false)
  assert.equal(H.strongerPCOn([{ id: '', cores: 2 }, { id: 'b', cores: 2, lan: true }]), false)
  assert.equal(H.strongerPCOn([{ id: '', cores: 2 }, { id: 'b', cores: 8, lan: false }]), false)
  assert.equal(H.strongerPCOn([{ id: '', cores: 2 }, { id: 'b', cores: 8, lan: true }]), true)
})

test('the heartbeat carries the specs', () => {
  const b = H.hardwareBeat()
  assert.deepEqual(Object.keys(b).sort(), ['bits', 'cores', 'link', 'mem_gb', 'weak'])
})

