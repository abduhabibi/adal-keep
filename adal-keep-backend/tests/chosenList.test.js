/**
 * chosenList.test.js — the check for newly chosen girls reads Employment Requests' list only (2026-11-26, the owner:
 * "not passport after passport"): one notice per real change (newly chosen, a stage moved, rejected / cancelled with its
 * reason), nothing twice, no profile made for a girl not here; a list card's reason read; Check now never searches a
 * passport. Mock list (Musaned's own data call answered in the test) and an in-memory database.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import knex from 'knex'

const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 }, migrations: { directory: new URL('../src/migrations', import.meta.url).pathname } })
await db.migrate.latest()
const C = await import('../src/services/musanedContracts.js')

const girl = async (name, passport) => (await db('profiles').insert({ full_name: name, passport_number: passport, status: 'active', created_at: new Date().toISOString() }))[0]
const row = (o) => ({ id: 1, candidateId: 0, orderNumber: '2005000001', visaNumber: '1900000001', candidateName: 'AMINA ALI HASSEN', passportNumber: 'EP1111111', status: 'EPRO_APPROVAL_PENDING', paymentStatus: 'PAID', createdAt: '2026-11-26T10:00:00', ...o })
let rows = []
const opened = []
const src = {
  gone: () => '',
  api: async (url) => ({ status: 200, json: { content: /page=0/.test(url) ? rows : [] } }),
  contract: async (card) => { opened.push(card.contract_number); return { pairs: {}, stages: [], pdfs: [], contract: card.contract_number } },
  pdf: async () => { throw new Error('no PDF in the mock') },
}
const notices = () => db('tasks').where('status', 'pending').select('title', 'description')
const scan = () => C.scanRows(db, src, { log: () => {} })

test('one notice per real change, nothing twice, no profile made', async () => {
  const amina = await girl('AMINA ALI HASSEN', 'EP1111111')
  rows = [row(), row({ id: 2, orderNumber: '2005000002', candidateName: 'NOT IN ADAL KEEP', passportNumber: 'EP9999999' })]
  await scan()
  let n = await notices()
  assert.deepEqual(n.map(x => x.title), ['Chosen on Musaned: AMINA ALI HASSEN'])
  assert.equal((await db('profiles').count('* as c').first()).c, 1, 'no profile made for the girl not here')
  await scan(); assert.equal((await notices()).length, 1, 'the same list: nothing new')
  assert.deepEqual(opened, ['2005000001'], 'only the changed request is opened, once')

  rows = [row({ status: 'FMOL_APPROVED' })]
  await scan(); await scan()
  n = await notices()
  assert.equal(n.filter(x => /→ FMOL APPROVED/.test(x.title)).length, 1)

  rows = [row({ status: 'REJECTED', rejectionReasonEn: 'The employer withdrew the request', rejectionReasonAr: 'سبب' })]
  await scan(); await scan()
  n = await notices()
  const rej = n.filter(x => /was REJECTED/.test(x.title))
  assert.equal(rej.length, 1); assert.match(rej[0].description, /Reason: The employer withdrew the request/)
  assert.equal(opened.length, 3, 'opened once per change')
  const p = await db('profiles').where('id', amina).first()
  assert.equal(p.musaned_stage, 'REJECTED')
})

test("a list card's reason, and the card without one", () => {
  assert.equal(C.parseCard('CANCELED\nCONTRACT NUMBER\n2005\nREASON\nVisa not issued').reason, 'Visa not issued')
  assert.equal(C.parseCard('EPRO APPROVAL\nCONTRACT NUMBER\n2005').reason, '')
  assert.equal(C.cardOfRow(row({ cancellationReason: 'Duplicate' })).reason, 'Duplicate')
})

test('Check now and the hourly check never search a passport', () => {
  const s = fs.readFileSync(new URL('../src/services/musanedContracts.js', import.meta.url), 'utf8')
  const body = (name) => s.slice(s.indexOf(`export async function ${name}(`), s.indexOf('\n}\n', s.indexOf(`export async function ${name}(`)))
  for (const f of ['scanContracts', 'checkContracts']) assert.ok(!/checkOne\(|search\(page/.test(body(f)), f)
  assert.ok(!/checkOne\(|search\(page/.test(s.slice(s.indexOf('async function checkContractsByApi('), s.indexOf('\n}\n', s.indexOf('async function checkContractsByApi(')))))
})

test.after(() => db.destroy())
