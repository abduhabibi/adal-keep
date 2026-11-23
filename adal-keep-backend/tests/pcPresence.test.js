import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import dgram from 'dgram'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-presence-'))
process.env.ADAL_SYNC_ID = path.join(dir, 'sync-id.json')
process.env.ADAL_LAN_RELEASE_DIR = path.join(dir, 'rel')
const P = await import('../src/services/pcPresence.js')
const I = await import('../src/services/sync/identity.js')
const { agencyTag } = await import('../src/services/lanRelease.js')

const TAG = agencyTag('47040')
const mine = () => ['192.168.1.20']

test('the permanent id: made once on the first start, never made again (a damaged or lost file comes back from its copy)', () => {
  const id = I.pcId()
  assert.match(id, /^[0-9a-f]{12}$/)
  I.forgetIdentity()
  assert.equal(I.pcId(), id)
  assert.ok(fs.existsSync(`${process.env.ADAL_SYNC_ID}.bak`))
  fs.writeFileSync(process.env.ADAL_SYNC_ID, '{ broken')
  I.forgetIdentity()
  assert.equal(I.pcId(), id, 'a damaged file')
  assert.ok(fs.readdirSync(dir).some(f => f.includes('.damaged-')), 'the damaged file is kept aside')
  fs.unlinkSync(process.env.ADAL_SYNC_ID)
  I.forgetIdentity()
  assert.equal(I.pcId(), id, 'a lost file')
  assert.equal(JSON.parse(fs.readFileSync(process.env.ADAL_SYNC_ID, 'utf8')).pc_id, id)
  // Joining later keeps it (only what changes is written).
  I.updateIdentity({ joined_main: 'http://192.168.1.4:4000' })
  I.forgetIdentity()
  assert.equal(I.pcId(), id)
})

test('the message: the same as the Go Companion says (presence.go)', () => {
  const m = P.message({ tags: [TAG], pcId: '0123456789ab', port: 4000, role: 'main', name: 'Main|PC', randomMac: true })
  assert.equal(m, `ADAL_KEEP_PC_V1|${TAG}|0123456789ab|4000|main|Main PC|randmac`)
  assert.deepEqual(P.parse(m), { tags: [TAG], pcId: '0123456789ab', port: 4000, role: 'main', name: 'Main PC', randomMac: true })
  assert.equal(P.parse('ADAL_KEEP_PC_V1|x|bad id!|4000|pc'), null)
  assert.equal(P.parse('ADAL_KEEP_PC_V1|x|0123456789ab|99999|pc'), null)
  assert.equal(P.parse('ADAL_KEEP_SERVER_V1|4000'), null)
})

test('only this agency\'s PCs, only on this PC\'s own network, never this PC itself', () => {
  const p = new P.Presence({ ownId: () => 'aaaaaaaaaaaa', tags: () => [TAG], mine })
  const say = (id, tag = TAG) => P.message({ tags: [tag], pcId: id, port: 4000 })
  assert.ok(p.heard(say('bbbbbbbbbbbb'), '192.168.1.7'))
  assert.ok(p.heard(say('cccccccccccc'), '::ffff:192.168.1.8'))
  assert.equal(p.heard(say('dddddddddddd', agencyTag('99999')), '192.168.1.9'), null, 'another agency')
  assert.equal(p.heard(say('dddddddddddd'), '100.89.1.2'), null, 'Tailscale')
  assert.equal(p.heard(say('dddddddddddd'), '169.254.1.2'), null, 'link-local')
  assert.equal(p.heard(say('dddddddddddd'), '10.86.0.5'), null, 'another subnet (an old hotspot)')
  assert.equal(p.heard(say('aaaaaaaaaaaa'), '192.168.1.20'), null, 'itself')
  assert.deepEqual(p.urlsOf('bbbbbbbbbbbb'), ['http://192.168.1.7:4000'])
  assert.deepEqual(p.urlsOf('cccccccccccc'), ['http://192.168.1.8:4000'])
  assert.deepEqual(p.urlsOf('dddddddddddd'), [])
})

test('a PC that gets a new address in the middle of the day is found at its next message; an old one is never given', () => {
  let t = 1000
  const p = new P.Presence({ ownId: () => 'aaaaaaaaaaaa', tags: () => [TAG], mine, now: () => t })
  const say = P.message({ tags: [TAG], pcId: '0123456789ab', port: 4000, role: 'main' })
  assert.equal(p.heard(say, '192.168.1.4').moved, null)
  t += 5000
  const e = p.heard(say, '192.168.1.12')
  assert.equal(e.moved, '192.168.1.4')
  assert.deepEqual(p.urlsOf('0123456789ab'), ['http://192.168.1.12:4000'])
  // A failed connection: not used until it says where it is again.
  p.failed('0123456789ab')
  assert.deepEqual(p.urlsOf('0123456789ab'), [])
  p.heard(say, '192.168.1.12')
  assert.deepEqual(p.urlsOf('0123456789ab'), ['http://192.168.1.12:4000'])
  // Not heard for longer than FRESH_MS (turned off): no address at all.
  t += P.FRESH_MS + 1
  assert.deepEqual(p.urlsOf('0123456789ab'), [])
  assert.equal(p.live().length, 0)
})

test('a new network card address (random hardware addresses) changes nothing: the id is the PC', () => {
  const p = new P.Presence({ ownId: () => 'aaaaaaaaaaaa', tags: () => [TAG], mine })
  const say = (rnd) => P.message({ tags: [TAG], pcId: '0123456789ab', port: 4000, randomMac: rnd })
  p.heard(say(false), '192.168.1.4')
  const e = p.heard(say(true), '192.168.1.4')
  assert.equal(e.moved, null)
  assert.equal(e.randomMac, true)
  assert.deepEqual(p.urlsOf('0123456789ab'), ['http://192.168.1.4:4000'])
})

test('random hardware addresses are seen on this PC (locally administered MAC)', () => {
  const ifs = {
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.20', mac: '06:11:22:33:44:55', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '192.168.1.21', mac: '00:1a:2b:3c:4d:5e', internal: false }],
    Tailscale: [{ family: 'IPv4', address: '100.89.1.2', mac: '02:00:00:00:00:01', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', mac: '00:00:00:00:00:00', internal: true }],
  }
  assert.deepEqual(P.randomMac(ifs), [{ name: 'Wi-Fi', mac: '06:11:22:33:44:55' }])
})

test('over a real socket: said every few seconds, heard by another PC', async () => {
  const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise(r => rx.bind(0, '127.0.0.1', r))
  const got = []
  rx.on('message', (b) => got.push(String(b)))
  const tx = dgram.createSocket('udp4')
  const p = P.startPresence({
    send: (text) => tx.send(text, rx.address().port, '127.0.0.1'),
    ownId: I.pcId, tags: () => [TAG], port: () => 4000, role: () => 'main', name: 'Main', log: { warn() {} },
  })
  try {
    await new Promise(r => setTimeout(r, 200))
    assert.ok(got.length >= 1)
    const m = P.parse(got[0])
    assert.equal(m.pcId, I.pcId())
    assert.equal(m.role, 'main')
    assert.deepEqual(m.tags, [TAG])
    assert.equal(P.presenceNow(), p)
  } finally { P.stopPresence(); rx.close(); tx.close() }
})

test('sync: a PC is tried where it says it is first, its saved old addresses not at all while it says it', async () => {
  const { SyncNode } = await import('../src/services/sync/node.js').catch(() => ({}))
  if (!SyncNode) return
  const p = P.startPresence({ send() {}, ownId: () => 'aaaaaaaaaaaa', tags: () => [TAG], port: () => 4000, role: () => 'pc', log: { warn() {} } })
  try {
    p.mine = () => ['192.168.1.20']
    p.heard(P.message({ tags: [TAG], pcId: '0123456789ab', port: 4000 }), '192.168.1.12')
    const node = Object.create(SyncNode.prototype)
    Object.defineProperty(node, 'pcId', { value: 'aaaaaaaaaaaa' })
    Object.assign(node, {
      peerState: new Map([['0123456789ab', { url: 'http://192.168.1.4:4000' }]]),
      roles: { pcs: async () => [{ pc_id: '0123456789ab', lan: ['192.168.1.4'], port: 4000 }], holder: () => '0123456789ab' },
      mainURL: () => '', addresses: () => ['192.168.1.20'], finder: null, trust: null,
    })
    const [o] = await node.others()
    assert.deepEqual(o.urls, ['http://192.168.1.12:4000'])
  } finally { P.stopPresence() }
})
