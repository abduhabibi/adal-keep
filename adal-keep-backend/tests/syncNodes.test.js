// Three Adal Keep PCs of one agency, each its own server on a spare port with
// its own database and documents (scratch folders), talking over HTTP as on
// the office network (services/sync/node.js, routes/sync.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'
import { makePC, dump, scratch } from './helpers/syncPCs.js'
import { SyncNode } from '../src/services/sync/node.js'
import { createSyncRouter } from '../src/routes/sync.js'
import { Relay, DirStore } from '../src/services/sync/relay.js'
import { LEASE } from '../src/services/sync/roles.js'

process.env.ADAL_SYNC_ID = path.join(scratch('id'), 'sync-id.json')
const quiet = { info() {}, warn() {} }

async function startPC(name, { slot, dir = scratch(name), now, key = crypto.randomBytes(24).toString('base64url'), mainURL = () => '', relayDir = null, claim = true, counter = null, pcId } = {}) {
  const pc = await makePC(name, { slot, dir, schema: !fs.existsSync(path.join(dir, 'data.sqlite')), now, pcId })
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  let node = null
  // (The main PC's number, as the network gate would have let it in.)
  app.use('/api', createSyncRouter({ getNode: () => node, here: () => true, admitted: (req) => (req.headers['x-test-number'] === '12345' ? { id: `acc-${name}`, name: 'joiner' } : null) }))
  const server = http.createServer(app)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const f = counter ? (url, o) => { counter(url); return fetch(url, o) } : fetch
  node = new SyncNode({ engine: pc.engine, safeDir: pc.safe, key, port, name, addresses: () => ['127.0.0.1'], mainURL, fetch: f, log: quiet, now: now || (() => Date.now()), licenceKey: 'test-licence-key' })
  if (relayDir) node.relay = new Relay(node, new DirStore(relayDir), { secret: 'agency-backup-key' })
  await node.start({ timers: false, claim })
  const me = { name, pc, node, server, port, url: `http://127.0.0.1:${port}`, key, dir }
  me.stop = async () => { node.stop(); await new Promise(r => server.close(r)); server.closeAllConnections?.(); await pc.close() }
  return me
}

/** A Companion joins: Main lets it in (the number), then it starts from a copy of Main's database. */
async function join(main, name, { slot, now, relayDir, counter } = {}) {
  const key = crypto.randomBytes(24).toString('base64url')
  const dir = scratch(name)
  const pcId = crypto.randomBytes(6).toString('hex')
  const r = await fetch(`${main.url}/api/sync/join`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-adal-pc': key, 'x-test-number': '12345' },
    body: JSON.stringify({ pc_id: pcId, name, lan: ['127.0.0.1'], port: 1 }),
  })
  const j = await r.json()
  assert.ok(r.ok, j.error)
  if (slot != null) assert.equal(j.slot, slot)
  await main.pc.db.raw('PRAGMA wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(main.pc.file, path.join(dir, 'data.sqlite'))
  const c = await startPC(name, { slot: j.slot, dir, now, key, mainURL: () => main.url, relayDir, claim: false, counter, pcId })
  return c
}

test('three PCs: edits anywhere, a CV made with Main off, documents fetched once, Main role moving, suspension', async (t) => {
  let clock = Date.now()
  const now = () => clock
  const relayDir = scratch('online')
  let docFetches = 0
  const main = await startPC('Main', { slot: 1, now, relayDir })
  // (The Companions' rows ask "http://127.0.0.1:<their port>": started below, then their row says their real port.)
  const comp = await join(main, 'Comp', { slot: 2, now, relayDir, counter: (u) => { if (u.includes('/api/sync/doc/')) docFetches++ } })
  const third = await join(main, 'Third', { slot: 3, now, relayDir })
  const pcs = [main, comp, third]
  try {
    await comp.node.selfRow(); await third.node.selfRow()
    for (const p of pcs) await p.node.round()
    for (const p of pcs) await p.node.round()
    assert.equal(main.node.roles.isMain(), true)
    assert.equal(comp.node.roles.isMain(), false)
    assert.equal(comp.node.roles.holder(), main.node.pcId)

    await t.test('a girl made on Main shows on both Companions; an edit on a Companion reaches all', async () => {
      const [id] = await main.pc.app('profiles').insert({ full_name: 'HANA GIRMA', passport_number: 'EP3333333' })
      fs.writeFileSync(path.join(main.pc.safe, '1795000000000_passport.jpg'), 'passport picture')
      await main.pc.app('profile_fields').insert({ profile_id: id, name: 'Passport' })
      for (const p of [comp, third]) await p.node.round()
      for (const p of [comp, third]) assert.equal((await dump(p.pc, 'profiles')).length, 1, p.name)
      assert.ok(fs.existsSync(path.join(comp.pc.safe, '1795000000000_passport.jpg')), 'the document came too')
      clock += 1000
      await comp.pc.app('profiles').where({ id }).update({ status: 'medical' })
      await comp.node.round()
      await third.node.round()
      assert.equal((await dump(third.pc, 'profiles'))[0].status, 'medical')
      assert.equal((await dump(main.pc, 'profiles'))[0].status, 'medical')
    })

    await t.test('a CV made on a Companion with Main off: Main gets the CV and its PDF later', async () => {
      const girl = (await dump(comp.pc, 'profiles'))[0]
      await main.stop()
      clock += 1000
      const pdf = Buffer.from('%PDF-1.4 the CV')
      const name = `AdalCV_${girl.id}_HANA_${clock}.pdf`
      fs.writeFileSync(path.join(comp.pc.safe, name), pdf)
      const [cvId] = await comp.pc.app('generated_cvs').insert({ profile_id: girl.id, filename: name, pdf_path: name, created_at: new Date(clock).toISOString() })
      assert.equal(cvId % 1000, 2, "made with the Companion's own slot")
      const r = await comp.node.round()
      assert.ok(r.last.peers.some(p => p.pc === main.node.pcId && !p.ok), 'Main is off')
      assert.ok(r.last.peers.some(p => p.pc === third.node.pcId && p.ok), 'the other Companion is there')
      // Main comes back (same database, same port).
      const again = await startPC('Main', { slot: 1, dir: main.dir, now, key: main.key, relayDir, claim: false })
      Object.assign(main, again)
      await main.node.round()
      const cvs = await dump(main.pc, 'generated_cvs')
      assert.equal(cvs.length, 1)
      assert.equal(cvs[0].pdf_path, name)
      assert.ok(fs.readFileSync(path.join(main.pc.safe, name)).equals(pdf), 'and its PDF')
    })

    await t.test('documents: the same content is fetched once; the same name with other content is kept beside', async () => {
      const same = Buffer.from('a medical report, scanned once')
      fs.writeFileSync(path.join(comp.pc.safe, 'medical-a.pdf'), same)
      fs.writeFileSync(path.join(main.pc.safe, 'medical-b.pdf'), same)          // the same paper, filed twice on Main
      fs.writeFileSync(path.join(main.pc.safe, 'clash.jpg'), 'main picture')
      fs.writeFileSync(path.join(comp.pc.safe, 'clash.jpg'), 'companion picture')
      const before = docFetches
      await comp.node.round()
      assert.ok(fs.readFileSync(path.join(comp.pc.safe, 'medical-b.pdf')).equals(same))
      const fetched = docFetches - before
      assert.equal(fetched, 1, 'medical-b is a copy of medical-a here: only the clashing picture is fetched')
      assert.equal(fs.readFileSync(path.join(comp.pc.safe, 'clash.jpg'), 'utf8'), 'companion picture', 'its own kept')
      const beside = fs.readdirSync(comp.pc.safe).filter(n => n.startsWith('clash.sync-'))
      assert.equal(beside.length, 1)
      assert.equal(fs.readFileSync(path.join(comp.pc.safe, beside[0]), 'utf8'), 'main picture', "Main's kept beside")
    })

    await t.test('a PC the network does not reach: through the online copy (locked)', async () => {
      const [id] = await third.pc.app('profiles').insert({ full_name: 'FAR AWAY', passport_number: 'EP4444444' })
      fs.writeFileSync(path.join(third.pc.safe, 'far-photo.jpg'), 'far photo')
      await third.pc.app('profiles').where({ id }).update({ photo_path: 'far-photo.jpg' })
      // Third is at home: nobody reaches it, it reaches nobody.
      const realOthers = third.node.others.bind(third.node)
      third.node.others = async () => (await realOthers()).map(p => ({ ...p, urls: ['http://127.0.0.1:9'] }))
      const homeComp = comp.node.others.bind(comp.node)
      comp.node.others = async () => (await homeComp()).map(p => (p.pc_id === third.node.pcId ? { ...p, urls: ['http://127.0.0.1:9'] } : p))
      const homeMain = main.node.others.bind(main.node)
      main.node.others = async () => (await homeMain()).map(p => (p.pc_id === third.node.pcId ? { ...p, urls: ['http://127.0.0.1:9'] } : p))
      try {
        const r = await third.node.round()
        assert.ok(r.last.relay && !r.last.relay.error, JSON.stringify(r.last.relay))
        const piece = fs.readdirSync(path.join(relayDir, 'sync', third.node.pcId))[0]
        assert.ok(!fs.readFileSync(path.join(relayDir, 'sync', third.node.pcId, piece)).includes('FAR AWAY'), 'only locked bytes online')
        await main.node.round()
        const far = (await dump(main.pc, 'profiles')).find(p => p.full_name === 'FAR AWAY')
        assert.ok(far, 'Main got it through the online copy')
        assert.equal(fs.readFileSync(path.join(main.pc.safe, 'far-photo.jpg'), 'utf8'), 'far photo', 'with its photo')
        // And the other way: Main's change reaches the PC at home.
        clock += 1000
        await main.pc.app('profiles').where({ id }).update({ status: 'ready' })
        await main.node.round()
        await third.node.round()
        assert.equal((await dump(third.pc, 'profiles')).find(p => p.id === id).status, 'ready')
      } finally {
        delete third.node.others; delete comp.node.others; delete main.node.others
      }
    })

    await t.test('the main role: refused while Main is seen, taken when it is gone, Main steps down when it is back', async () => {
      await assert.rejects(comp.node.roles.take(), /is the main PC/)
      await main.stop()
      clock += LEASE + 60000
      let heard = null
      comp.node.roles.onRole((r) => { heard = r })
      await comp.node.roles.take({ by: 'test' })
      assert.equal(comp.node.roles.isMain(), true)
      await comp.node.round()
      await third.node.round()
      assert.equal(third.node.roles.holder(), comp.node.pcId, 'the others follow')
      const again = await startPC('Main', { slot: 1, dir: main.dir, now, key: main.key, relayDir, claim: true })
      Object.assign(main, again)
      let stepped = null
      main.node.roles.onRole((r) => { stepped = r })
      assert.equal(main.node.roles.isMain(), true, 'it still thinks it is main until it hears')
      await main.node.round()
      assert.equal(main.node.roles.isMain(), false, 'and steps down when it hears')
      assert.deepEqual(stepped, { holder: comp.node.pcId, mine: false })
      assert.ok(heard === null || heard.mine === true)
      // The new main hands it back.
      await comp.node.roles.handTo(main.node.pcId)
      await main.node.round()
      assert.equal(main.node.roles.isMain(), true)
    })

    await t.test('licence: the main PC writes it, the others follow it (signed)', async () => {
      await main.node.roles.publishLicence({ mode: 'active', paidUntil: clock + 86400000 * 30, pcNumber: '123455' })
      await comp.node.round()
      const l = comp.node.roles.licence()
      assert.equal(l.mode, 'active')
      assert.equal(l.from, main.node.pcId)
      // A forged one (another key) is not taken.
      await comp.pc.db.raw(`UPDATE sync_role SET data = ? WHERE k = 'licence'`, [JSON.stringify({ ...l, mode: 'active', paidUntil: clock * 2, sig: 'x' })])
      await comp.node.roles.refresh()
      assert.equal(comp.node.roles.licence(), null)
      await comp.pc.db.raw(`DELETE FROM sync_role WHERE k = 'licence'`)   // (put back below)
      await main.node.roles.publishLicence({ mode: 'active', paidUntil: clock + 86400000 * 31, pcNumber: '123455' })
      await comp.node.round()
    })

    await t.test('suspended on Main: every PC refuses it, and it stops', async () => {
      await main.node.setCut(third.node.pcId, 'suspend')
      await comp.node.round()
      const r = await fetch(`${comp.url}/api/sync/hello`, { headers: { 'x-adal-pc': third.key } })
      assert.equal(r.status, 403)
      assert.equal((await r.json()).suspended, true)
      await third.node.round().catch(() => {})
      await third.node.round().catch(() => {})
      assert.equal(third.node.cutOff, 'suspended')
      // Allowed again.
      await main.node.setCut(third.node.pcId, 'allow')
      await comp.node.round()
      assert.equal((await fetch(`${comp.url}/api/sync/hello`, { headers: { 'x-adal-pc': third.key } })).status, 200)
    })

    await t.test('every PC ends with the same data', async () => {
      for (let i = 0; i < 2; i++) for (const p of [main, comp]) await p.node.round()
      third.node.cutOff = null
      await third.node.round()
      for (const table of ['profiles', 'profile_fields', 'generated_cvs']) {
        assert.deepEqual(await dump(comp.pc, table), await dump(main.pc, table), table)
        assert.deepEqual(await dump(third.pc, table), await dump(main.pc, table), table)
      }
    })
  } finally {
    for (const p of pcs) await p.stop().catch(() => {})
  }
})
