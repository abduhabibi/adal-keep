// Profiles are made only from a passport (owner, 2026-11-26): downloads are judged by the machine-readable lines on this PC (no JEV,
// no Gemini); the contracts check never creates a profile; the one-word profiles it made are picked by one exact rule.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'
import { makeSet } from '../scripts/passport-set.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponly-'))
const set = (await makeSet(dir)).filter(f => f.name !== 'form-table.jpg')   // (the slow dense page is in scripts/bench-passport-detect.mjs)
const real = globalThis.fetch; let fetched = 0
globalThis.fetch = async () => { fetched++; throw new Error('no network in this test') }
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'JEV_API_KEY']) delete process.env[k]
const O = await import('../src/services/passportOnly.js')
const { stopMrzReader } = await import('../src/services/quickMrz.js')
after(async () => { await (await import('../src/services/docPipeline.js')).settleBackground(); globalThis.fetch = real; await stopMrzReader(); await (await import('../src/services/passportVisual.js')).stopVisualReader() })

const db = async () => {
  const d = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 }, migrations: { directory: new URL('../src/migrations', import.meta.url).pathname } })
  await d.migrate.latest(); return d
}

test('the test set: every passport is recognised, nothing else is, and the network is never touched', async () => {
  const wrong = []
  for (const f of set) {
    const r = await O.analyzeLocalPassport(f.file)
    if ((r.doc_type === 'Passport') !== f.yes) wrong.push(f.name)
    if (f.yes) { assert.equal(r.fields.passport_number, 'L898902C3', f.name); assert.equal(r.source, 'mrz-local') }
  }
  assert.deepEqual(wrong, [])
  assert.equal(fetched, 0)
})

test('a dropped file: a passport makes a profile, anything else is left alone (no profile, no AI)', async () => {
  const { processFile } = await import('../src/services/aiIngestion.js')
  const d = await db()
  const pass = set.find(f => f.name === 'passport-big.jpg'), other = set.find(f => f.name === 'letter.jpg'), portrait = set.find(f => f.name === 'portrait.jpg')
  const copy = (f) => { const c = path.join(dir, `drop-${f.name}`); fs.copyFileSync(f.file, c); return c }
  const r0 = await processFile(copy(other), d); assert.equal(r0.ok, false); assert.equal(r0.reason, 'other')
  const r1 = await processFile(copy(portrait), d); assert.equal(r1.ok, false)
  assert.equal((await d('profiles').count({ c: '*' }).first()).c, 0)
  assert.equal((await d('files').count({ c: '*' }).first()).c, 0)
  const r2 = await processFile(copy(pass), d); assert.equal(r2.ok, true)
  const p = await d('profiles').first()
  assert.equal(p.passport_number, 'L898902C3')
  assert.equal(fetched, 0)                                   // not one call out: JEV and Gemini were not asked
  await d.destroy()
})

test('the contracts check updates a profile it finds but never creates one', async () => {
  const C = await import('../src/services/musanedContracts.js')
  const d = await db()
  const row = (name, passport) => ({ id: 1, candidateId: 9, candidateName: name, passportNumber: passport, orderNumber: '555', status: 'ACCEPTED', paymentStatus: 'PAID' })
  let contracts = 0
  const src = { api: async () => ({ status: 200, json: { content: [row('ABDI', 'EP7654321')] } }), contract: async () => { contracts++; return { pairs: [] } }, pdf: async () => null }
  const r = await C.scanRows(d, src, { log: () => {} })
  assert.equal((await d('profiles').count({ c: '*' }).first()).c, 0)
  assert.equal(contracts, 0)                                  // nothing was even opened for her
  assert.ok(r.results.some(x => x.state === 'not-added' && x.passport === 'EP7654321'))
  assert.deepEqual(r.added, [])
  // addFromMusaned (the page way): not found by passport -> skipped, nothing made
  const a = await C.addFromMusaned(d, null, null, { candidate: 'ALI', contract_number: '1' }, { pairs: [['Passport Number', 'EP1111111']] })
  assert.equal(a.skipped, true); assert.equal((await d('profiles').count({ c: '*' }).first()).c, 0)
  await d.destroy()
})

test('the one-word profiles the contracts check made are picked by one rule, and nothing else', async () => {
  const d = await db()
  const now = new Date().toISOString()
  const mk = (full_name, created_by, extra = {}) => d('profiles').insert({ full_name, created_by, created_at: now, updated_at: now, ...extra })
  await mk('ABDI', 'Musaned list')                       // yes
  await mk('KEMAL', 'Musaned list')                      // yes
  await mk('ABDI MOHAMMED ALI', 'Musaned list')          // two+ words: no
  await mk('MUHAMMED', 'System')                         // one word but not made by the contracts check: no
  await mk('AHMED', 'Aisha')                             // a person's own: no
  const rows = await d('profiles').whereRaw(O.ONE_WORD_RULE).orderBy('id')
  assert.deepEqual(rows.map(r => r.full_name), ['ABDI', 'KEMAL'])
  assert.deepEqual((await d('profiles')).filter(O.isOneWordContractProfile).map(r => r.full_name), ['ABDI', 'KEMAL'])
  await d.destroy()
})

test('the off switches bring the old ways back', () => {
  process.env.ADAL_DOWNLOAD_AI = '1'; process.env.ADAL_MUSANED_CREATES = '1'
  try { assert.equal(O.downloadsUseAI(), true); assert.equal(O.contractsMayCreate(), true) } finally { delete process.env.ADAL_DOWNLOAD_AI; delete process.env.ADAL_MUSANED_CREATES }
  assert.equal(O.downloadsUseAI(), false); assert.equal(O.contractsMayCreate(), false)
})
