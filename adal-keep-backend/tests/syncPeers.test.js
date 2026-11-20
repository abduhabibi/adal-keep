// The agency's PCs find each other on the office network and copy with ANY of
// them, with no hub (services/sync/peers.js, node.js): the broadcast, the
// network card (ARP), another agency ignored, changes passed on by a PC
// in the middle.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import http from 'http'
import dgram from 'dgram'
import crypto from 'crypto'
import express from 'express'
import { makePC, dump, scratch } from './helpers/syncPCs.js'
import { SyncNode } from '../src/services/sync/node.js'
import { createSyncRouter, compareVectors } from '../src/routes/sync.js'
import { PeerFinder, PEER_ASK, PEER_HERE, rootTag, numberTag, parseProcArp, parseArpA } from '../src/services/sync/peers.js'

process.env.ADAL_SYNC_ID = path.join(scratch('id'), 'sync-id.json')
const quiet = { info() {}, warn() {} }

async function startPC(name, { slot, dir = scratch(name), key = crypto.randomBytes(24).toString('base64url'), claim = true, pcId, macs = [] } = {}) {
  const pc = await makePC(name, { slot, dir, schema: !fs.existsSync(path.join(dir, 'data.sqlite')), pcId })
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  let node = null
  app.use('/api', createSyncRouter({ getNode: () => node, here: () => true, admitted: (req) => (req.headers['x-test-number'] === '12345' ? { id: `acc-${name}`, name: 'joiner' } : null) }))
  const server = http.createServer(app)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  node = new SyncNode({ engine: pc.engine, safeDir: pc.safe, key, port, name, addresses: () => ['127.0.0.1'], macs: () => macs, log: quiet, licenceKey: 'test-licence-key' })
  await node.start({ timers: false, claim })
  const me = { name, pc, node, server, port, url: `http://127.0.0.1:${port}`, key, dir }
  me.stop = async () => { node.stop(); await new Promise(r => server.close(r)); server.closeAllConnections?.(); await pc.close() }
  return me
}
async function join(main, name, opts = {}) {
  const key = crypto.randomBytes(24).toString('base64url')
  const dir = scratch(name)
  const pcId = crypto.randomBytes(6).toString('hex')
  const r = await fetch(`${main.url}/api/sync/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adal-pc': key, 'x-test-number': '12345' }, body: JSON.stringify({ pc_id: pcId, name, lan: ['127.0.0.1'], port: 1 }) })
  const j = await r.json()
  assert.ok(r.ok, j.error)
  await main.pc.db.raw('PRAGMA wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(main.pc.file, path.join(dir, 'data.sqlite'))
  return startPC(name, { slot: j.slot, dir, key, claim: false, pcId, ...opts })
}
/** Only these PCs answer this one (as if the others were on another network). */
function onlyReaches(pc, ...peers) {
  const ids = new Set(peers.map(p => p.node.pcId))
  const others = pc.node.others.bind(pc.node)
  pc.node.others = async () => (await others()).filter(p => ids.has(p.pc_id))
}
const badAddress = async (on, of) => { await on.pc.db.raw(`UPDATE sync_pcs SET lan = '["10.255.255.1"]', port = 9 WHERE pc_id = ?`, [of.node.pcId]); await on.node.engine.stampNow() }

test('the agency\'s PCs find each other, copy with any of them, and ignore another agency', async (t) => {
  const main = await startPC('Main', { slot: 1, macs: ['aa:bb:cc:00:00:01'] })
  const a = await join(main, 'CompA', { macs: ['aa:bb:cc:00:00:0a'] })
  const b = await join(main, 'CompB', { macs: ['aa:bb:cc:00:00:0b'] })
  const other = await startPC('OtherAgency', { slot: 1 })
  const all = [main, a, b]
  try {
    for (const p of all) await p.node.selfRow()
    for (let i = 0; i < 2; i++) for (const p of all) await p.node.round()
    for (const p of [...all, other]) { p.node.finder = new PeerFinder(p.node, { port: 1, macs: p.node.macs, log: quiet }); await p.node.finder.refresh() }

    await t.test('one agency, one tag; another agency has its own', () => {
      assert.deepEqual(a.node.finder.tags, main.node.finder.tags)
      assert.deepEqual(b.node.finder.tags, main.node.finder.tags)
      assert.equal(main.node.finder.tags[0], rootTag(main.node.pcId))
      assert.notDeepEqual(other.node.finder.tags, main.node.finder.tags)
      assert.ok(!main.node.finder.tags.join().includes(main.node.pcId))
      assert.equal(numberTag('470 401'), numberTag('470401'))
    })

    await t.test('a message is taken only from a PC of this agency (tag and list)', () => {
      const f = a.node.finder
      const ask = b.node.finder.line(PEER_ASK)
      const answer = f.heard(ask, { address: '192.168.1.23', port: 5000 })
      assert.ok(answer?.startsWith(PEER_HERE + '|'))
      assert.deepEqual(f.urlsOf(b.node.pcId), [`http://192.168.1.23:${b.port}`, `http://127.0.0.1:${b.port}`])
      assert.deepEqual(f.found.get(b.node.pcId).macs, ['aa:bb:cc:00:00:0b'])
      // Another agency's PC: its tag is not ours → not heard, not answered.
      const before = f.ignored
      assert.equal(f.heard(other.node.finder.line(PEER_ASK), { address: '192.168.1.99' }), null)
      assert.equal(f.found.has(other.node.pcId), false)
      // Our tag but a PC not on our list (a copied message, a removed PC) → not heard.
      const forged = b.node.finder.line(PEER_ASK).replace(b.node.pcId, 'abcdefabcdef')
      assert.equal(f.heard(forged, { address: '192.168.1.98' }), null)
      assert.equal(f.ignored, before + 2)
      // Itself → nothing.
      assert.equal(f.heard(f.line(PEER_ASK), { address: '127.0.0.1' }), null)
      // Garbage → nothing.
      assert.equal(f.heard('ADAL_KEEP_PEERS_V1|x', { address: '1.2.3.4' }), null)
    })

    await t.test('over UDP: the broadcast is answered by the agency\'s PCs only', async () => {
      // Each PC's answering socket (discovery.js does this on 45454); here one port each, on 127.0.0.1.
      const socks = []
      const listen = (p) => new Promise((res) => {
        const s = dgram.createSocket('udp4')
        s.on('message', (msg, r) => { const ans = p.node.finder.heard(msg.toString(), r); if (ans) s.send(Buffer.from(ans), r.port, r.address) })
        s.bind(0, '127.0.0.1', () => { socks.push(s); res(s.address().port) })
      })
      const portB = await listen(b), portOther = await listen(other)
      a.node.finder.found.clear()
      for (const port of [portB, portOther]) { a.node.finder.port = port; a.node.finder.targets = () => ['127.0.0.1']; await a.node.finder.search({ wait: 400 }) }
      assert.ok(a.node.finder.urlsOf(b.node.pcId).includes(`http://127.0.0.1:${b.port}`))
      assert.equal(a.node.finder.found.has(other.node.pcId), false)
      // B heard A's ask too (it learns A's address from it).
      assert.ok(b.node.finder.urlsOf(a.node.pcId).length)
      assert.ok(other.node.finder.ignored >= 1)
      for (const s of socks) s.close()
    })

    await t.test('Main off: the Companions copy with each other; an address that changed is found by the broadcast', async () => {
      onlyReaches(a, b); onlyReaches(b, a)
      await badAddress(a, b)   // (A's list has an old address for B)
      a.node.peerState.clear()
      const [id] = await b.pc.app('profiles').insert({ full_name: 'MADE ON B', passport_number: 'EPB0001' })
      await b.node.engine.stampNow()
      // The broadcast says where B is now.
      a.node.finder.found.set(b.node.pcId, { urls: [b.url], macs: [], at: Date.now() })
      const r = await a.node.round()
      assert.equal(r.last.peers.find(p => p.pc === b.node.pcId)?.ok, true, JSON.stringify(r.last.peers))
      assert.equal((await dump(a.pc, 'profiles')).find(p => p.id === id)?.full_name, 'MADE ON B')
      await a.pc.app('profiles').where({ id }).update({ phone_number: '0911777888' })
      await a.node.round()
      assert.equal((await b.pc.app('profiles').where({ id }).first()).phone_number, '0911777888')
    })

    await t.test('no broadcast answer: found by its network card in the neighbour table (ARP)', async () => {
      await badAddress(a, b)
      a.node.peerState.clear(); a.node.finder.found.clear()
      a.node.finder.neighbours = async () => ({ '10.0.0.9': 'aa:bb:cc:00:00:99', '127.0.0.1': 'aa:bb:cc:00:00:0b' })
      const pc = (await a.node.others()).find(p => p.pc_id === b.node.pcId)
      assert.deepEqual(pc.macs, ['aa:bb:cc:00:00:0b'])
      assert.deepEqual(await a.node.finder.byCard(pc), [`http://127.0.0.1:${pc.port}`])
      // (The row's port is wrong too: the card finder uses it, so put the right one back for this part.)
      await a.pc.db.raw(`UPDATE sync_pcs SET port = ? WHERE pc_id = ?`, [b.port, b.node.pcId])
      const r = await a.node.round()
      assert.equal(r.last.peers.find(p => p.pc === b.node.pcId)?.ok, true)
      assert.equal(a.node.peerState.get(b.node.pcId).url, `http://127.0.0.1:${b.port}`)
    })

    await t.test('a PC in the middle passes changes on (A ↔ B ↔ Main, A never meets Main)', async () => {
      onlyReaches(a, b); onlyReaches(main, b)
      const [id] = await a.pc.app('profiles').insert({ full_name: 'MADE ON A', passport_number: 'EPA0009' })
      await a.node.round()          // A → B
      await main.node.round()       // Main ← B (A's entry, relayed)
      assert.equal((await main.pc.app('profiles').where({ id }).first())?.full_name, 'MADE ON A')
      await main.pc.app('profiles').where({ id }).update({ phone_number: '0911000999' })
      await main.node.round(); await a.node.round()
      assert.equal((await a.pc.app('profiles').where({ id }).first()).phone_number, '0911000999')
    })

    await t.test('the list says who is in sync and who is behind', async () => {
      assert.deepEqual(compareVectors({ x: 5, y: 2 }, { x: 5, y: 2 }), { they_lack: 0, we_lack: 0 })
      assert.deepEqual(compareVectors({ x: 5, y: 2 }, { x: 3, z: 4 }), { they_lack: 4, we_lack: 4 })
      await b.node.round(); await a.node.round()
      const st = a.node.peerState.get(b.node.pcId)
      assert.deepEqual(compareVectors(await a.node.engine.vector(), st.vector), { they_lack: 0, we_lack: 0 })
    })

    await t.test('the neighbour tables are read', () => {
      assert.deepEqual(parseProcArp('IP address HW type Flags HW address Mask Device\n192.168.1.5 0x1 0x2 AA:BB:CC:DD:EE:FF * wlan0\n192.168.1.6 0x1 0x0 00:00:00:00:00:00 * wlan0'), { '192.168.1.5': 'aa:bb:cc:dd:ee:ff' })
      assert.deepEqual(parseArpA('  192.168.1.7           aa-bb-cc-dd-ee-01     dynamic\n? (192.168.1.8) at a:b:c:d:e:f on en0'), { '192.168.1.7': 'aa:bb:cc:dd:ee:01', '192.168.1.8': '0a:0b:0c:0d:0e:0f' })
    })
  } finally {
    for (const p of [...all, other]) await p.stop()
  }
})
