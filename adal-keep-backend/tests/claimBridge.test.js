/**
 * claimBridge.test.js — Adal Robots asks Umar's run claims through Adal Keep's server (where the PC copying is):
 * this PC only, the robots' token; a refused run waits in line again; no answer → the run goes on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-bridge-'))
process.env.ADAL_ROBOTS_DATA = tmp
fs.writeFileSync(path.join(tmp, 'robots-token'), 'x'.repeat(48))
const B = await import('../src/services/claimBridge.js')
const R = await import('../src/services/runClaims.js')
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('the robots ask the server; another PC holding the girl and site says no', async (t) => {
  // runClaims with a fake office: one other PC that holds slot-7's girl 5 on Musaned.
  R._setEnvForTests({
    me: { pc_id: 'COMP', pc_name: 'COMP' }, slot: () => 7, isMain: () => false, now: () => Date.now(), store: null,
    node: { others: async () => [{ pc_id: 'MAIN', name: 'MAIN', slot: 0 }], call: async () => ({ granted: false, holder: { pc_name: 'MAIN' }, why: 'MAIN is doing it' }), reach: async () => 'http://main', peerState: new Map() },
  })
  const app = express(); app.use(express.json()); app.locals.db = null
  app.use('/api', B.claimRoutes(express))
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  t.after(() => { srv.close(); R._setEnvForTests(null); delete process.env.ADAL_ROBOT_PROCESS; delete process.env.ADAL_SERVER_URL })
  process.env.ADAL_ROBOT_PROCESS = '1'
  process.env.ADAL_SERVER_URL = `http://127.0.0.1:${srv.address().port}`
  const job = { id: Date.now() * 1000 + 7, profile_id: 5, workflow_id: 'musaned_add_candidate' }
  const c = await B.claimForRun(null, job)
  assert.equal(c.ok, false, JSON.stringify(c)); assert.equal(c.by, 'MAIN')
  // Without the token: refused.
  const r = await fetch(`${process.env.ADAL_SERVER_URL}/api/run-claims/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(r.status, 403)
  // The server does not answer: the run goes on.
  process.env.ADAL_SERVER_URL = 'http://127.0.0.1:9'
  assert.equal((await B.claimForRun(null, job)).ok, true)
  await B.releaseForRun(null, job, 'done')   // never throws
})
