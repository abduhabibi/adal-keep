// A Companion joins with the main PC's number and gets its own full copy from
// the main PC over HTTP — the locked snapshot pieces of routes/replica.js —
// then works on it and copies back (services/sync/bootstrap.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'
import { scratch, makePC, dump } from './helpers/syncPCs.js'

const dir = scratch('join')
fs.mkdirSync(path.join(dir, 'main'), { recursive: true })
process.env.SQLITE_PATH = path.join(dir, 'main', 'data.sqlite')
process.env.ADAL_BACKUP_STATE = path.join(dir, 'backup-state.json')
process.env.SECRETS_PATH = path.join(dir, 'secrets.enc')
process.env.ACCOUNT_VAULT_KEY = path.join(dir, 'account-vault.key')
process.env.ADAL_BACKUP_SAFE = path.join(dir, 'main', 'SafeStorage')
process.env.ADAL_REPLICA_SNAPS = path.join(dir, 'snaps')
process.env.ADAL_REPLICA_LIST = path.join(dir, 'replicas.json')
process.env.ADAL_SYNC_ID = path.join(dir, 'sync-id.json')
process.env.SUPABASE_URL = ''
process.env.SUPABASE_ANON_KEY = ''

test('a Companion joins: its slot, the agency copy, then both ways', async () => {
  const { setSecret } = await import('../src/services/secretStore.js')
  const { createSyncRouter } = await import('../src/routes/sync.js')
  const { SyncNode } = await import('../src/services/sync/node.js')
  const { joinAgency } = await import('../src/services/sync/bootstrap.js')
  const replicaRouter = (await import('../src/routes/replica.js')).default
  setSecret('backup_password', 'the-agency-backup-key')

  const main = await makePC('JMain', { slot: 1, dir: path.join(dir, 'main') })
  const [girl] = await main.app('profiles').insert({ full_name: 'TIGIST ALEMU', passport_number: 'EP5555555' })
  await main.app('settings').insert({ key: 'agency_name', value: 'Sunrise' })

  // The main PC: its number lets a computer in (as /pc-access/number), then the replica and the copying.
  const keys = new Map()
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  app.use((req, res, next) => { const k = req.headers['x-adal-pc']; if (keys.has(k)) req.pcAccess = keys.get(k); next() })
  app.post('/api/pc-access/number', (req, res) => {
    if (req.body.number !== '12345') return res.status(403).json({ error: "That is not the main PC's number" })
    const key = crypto.randomBytes(24).toString('base64url'), id = crypto.randomBytes(6).toString('hex')
    keys.set(key, { id, name: req.body.name })
    res.json({ ok: true, id, key })
  })
  let node = null
  app.use('/api', createSyncRouter({ getNode: () => node, here: () => false }))
  app.use('/api', replicaRouter)
  const server = http.createServer(app)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  node = new SyncNode({ engine: main.engine, safeDir: main.safe, key: 'main-key', port: server.address().port, name: 'Main', addresses: () => ['127.0.0.1'], log: { info() {}, warn() {} } })
  await node.start({ timers: false })

  try {
    await assert.rejects(joinAgency({ mainUrl: url, number: '99999', name: 'Front desk', pcId: 'c0ffee000001', dbFile: 'x', onlineCopy: false }), /not the main PC's number/)
    const steps = []
    const got = await joinAgency({ mainUrl: url, number: '12345', name: 'Front desk', pcId: 'c0ffee000001', lan: ['127.0.0.1'], port: 1, dbFile: 'x', onlineCopy: false, progress: (p) => steps.push(p.step) })
    assert.equal(got.slot, 2, 'the next slot')
    assert.equal(got.main_pc, main.engine.pcId)
    assert.equal(got.secrets.password, 'the-agency-backup-key')
    assert.ok(steps.includes('database'))
    // Every PC now knows this one (its key on the agency's list).
    const row = (await main.db.raw(`SELECT * FROM sync_pcs WHERE pc_id = 'c0ffee000001'`))[0]
    assert.equal(row.slot, 2)
    assert.equal(node.peerByKey(got.key).pc_id, 'c0ffee000001')

    // The copy goes in (the next start, as stageJoin does) and the Companion works on it.
    fs.mkdirSync(path.join(dir, 'comp'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'comp', 'data.sqlite'), got.raw)
    const comp = await makePC('JComp', { slot: got.slot, dir: path.join(dir, 'comp'), schema: false, pcId: 'c0ffee000001' })
    try {
      assert.deepEqual((await dump(comp, 'profiles')).map(p => p.full_name), ['TIGIST ALEMU'])
      const cnode = new SyncNode({ engine: comp.engine, safeDir: comp.safe, key: got.key, port: 1, name: 'Front desk', mainURL: () => url, log: { info() {}, warn() {} } })
      await cnode.start({ timers: false, claim: false })
      assert.equal(cnode.roles.holder(), main.engine.pcId, 'the main PC holds the role')
      await comp.app('profiles').where({ id: girl }).update({ status: 'ready' })
      const [cv] = await comp.app('generated_cvs').insert({ profile_id: girl, filename: 'cv.pdf', pdf_path: 'cv.pdf' })
      assert.equal(cv % 1000, 2)
      // (Main does not reach it in this test: the Companion's round does both ways.)
      cnode.others = async () => [{ pc_id: main.engine.pcId, name: 'Main', urls: [url] }]
      const r = await cnode.round()
      assert.ok(r.last.peers[0].ok, JSON.stringify(r.last.peers))
      assert.equal((await dump(main, 'profiles'))[0].status, 'ready')
      assert.equal((await dump(main, 'generated_cvs')).length, 1)
    } finally { await comp.close() }
  } finally {
    server.close(); server.closeAllConnections?.()
    await main.close()
  }
})
