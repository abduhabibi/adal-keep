import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.ADAL_LAN_RELEASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-lan-'))
const L = await import('../src/services/lanRelease.js')

test('a newer release is one published later with another sha; the same sha never again', () => {
  const mine = { sha: 'a'.repeat(40), published_at: '2026-11-19T10:00:00.000Z' }
  assert.equal(L.isNewer({ sha: 'b'.repeat(40), published_at: '2026-11-19T11:00:00.000Z' }, mine), true)
  assert.equal(L.isNewer({ sha: 'a'.repeat(40), published_at: '2026-11-19T12:00:00.000Z' }, mine), false)
  assert.equal(L.isNewer({ sha: 'b'.repeat(40), published_at: '2026-11-19T09:00:00.000Z' }, mine), false)
  assert.equal(L.isNewer({ sha: 'b'.repeat(40) }, null), true)
})

test('news from the network: kept as a peer; nonsense is ignored', () => {
  assert.equal(L.heard(`ADAL_KEEP_RELEASE_V1|${'c'.repeat(40)}|2026-11-19T11:00:00.000Z|47810|/lan`, '192.168.1.30'), true)
  assert.deepEqual(L.peersWith('c'.repeat(40)), ['http://192.168.1.30:47810/lan'])
  assert.equal(L.heard('ADAL_KEEP_RELEASE_V1|nothex|x|47810|/lan', '192.168.1.31'), false)
  assert.equal(L.heard(`ADAL_KEEP_RELEASE_V1|${'c'.repeat(40)}|x|80|/../etc`, '192.168.1.32'), false)
  assert.equal(L.heard('HELLO', '192.168.1.33'), false)
})

test('an unsigned release is never kept to hand on; a piece that does not match is not kept', async () => {
  assert.equal(await L.recordInstalled({ manifest: { sha: 'd'.repeat(40) }, signature: 'AAAA' }), false)
  assert.equal(L.current(), null)
  const f = path.join(process.env.ADAL_LAN_RELEASE_DIR, 'x')
  fs.writeFileSync(f, 'hello')
  assert.equal(await L.keepPiece('0'.repeat(64), f), false)
  assert.equal(await L.keepPiece('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', f), true)
})

test('never downgrading (2026-11-19): only forward, by publish order, then commit date', () => {
  const main = { sha: '1'.repeat(40), published_at: '2026-11-18T10:00:00.000Z', date: '2026-11-18T12:00:00+03:00' }
  const companion = { sha: '2'.repeat(40), published_at: '2026-11-19T10:00:00.000Z', date: '2026-11-19T12:00:00+03:00' }
  // A PC with the newer release never takes the main PC's older one; the main PC takes the newer one.
  assert.equal(L.isNewer(main, companion), false)
  assert.equal(L.isNewer(companion, main), true)
  // Published later but older code: refused, unless Adal rolled back on purpose.
  const republished = { ...main, published_at: '2026-11-20T10:00:00.000Z' }
  assert.equal(L.isNewer(republished, companion), false)
  assert.equal(L.isNewer({ ...republished, rollback_of: companion.sha }, companion), true)
  // A USB install known only by its commit date.
  const usb = { sha: '3'.repeat(40), date: '2026-11-19T08:00:00Z' }
  assert.equal(L.isNewer(main, usb), false)
  assert.equal(L.isNewer(companion, usb), true)
  // The sequence wins; short sha = the same; unknown order = never.
  assert.equal(L.isNewer({ sha: '4'.repeat(40), seq: 9, published_at: '2026-01-01T00:00:00Z' }, { sha: '5'.repeat(40), seq: 8, published_at: '2026-02-01T00:00:00Z' }), true)
  assert.equal(L.isNewer({ sha: companion.sha.slice(0, 7), published_at: '2027-01-01T00:00:00Z' }, companion), false)
  assert.equal(L.isNewer({ sha: '6'.repeat(40) }, companion), false)
  assert.equal(L.orderKnown({ sha: 'x' }), false)
  assert.equal(L.orderKnown(usb), true)
})
