import test from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'
import { agentLimit, setAgentLimit, giveAgent, takeAgent, agentList, giveTemplate, roomForAgent } from '../src/services/whatsapp.js'

async function fresh() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('settings', t => { t.increments('id'); t.string('key'); t.text('value') })
  await db.schema.createTable('whatsapp_agents', t => { t.increments('id'); t.string('name'); t.string('chat_id'); t.text('template_ids'); t.string('musaned_office'); t.integer('active'); t.string('user_key'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('cv_templates', t => { t.increments('id'); for (const c of ['name', 'agency_name', 'agency_name_ar', 'currency', 'country', 'source_file', 'created_at', 'updated_at']) t.string(c); t.integer('salary'); t.integer('contract_years'); t.text('html_content'); t.text('css_content'); t.text('placeholders'); t.boolean('is_active') })
  return db
}
const tpl = { name: 'Riyadh office', html_content: '<p>{{NAME}}</p>' }

test('no plan set: as many agents as they want; a plan stops the next one', async () => {
  const db = await fresh()
  try {
    assert.equal(await agentLimit(db), null)
    await giveAgent(db, { name: 'A', number: '+966 50 111' })
    await giveAgent(db, { name: 'B', number: '966502' })
    assert.equal(await setAgentLimit(db, 2), 2)
    await assert.rejects(giveAgent(db, { name: 'C', number: '966503', templates: [tpl] }), /plan has 2 agents/)
    assert.equal((await db('cv_templates')).length, 0)        // refused: nothing left behind
    assert.equal(await setAgentLimit(db, 3), 3)               // a bigger offer
    assert.equal((await giveAgent(db, { name: 'C', number: '966503' })).length, 3)
    await assert.rejects(roomForAgent(db), /plan has 3/)
    assert.equal(await setAgentLimit(db, 0), null)            // no limit again
  } finally { await db.destroy() }
})

test('an agent comes with its template, once, and the number reads plainly', async () => {
  const db = await fresh()
  try {
    const list = await giveAgent(db, { name: 'A', number: '+966 50 111', templates: [tpl] })
    assert.deepEqual(list.map(a => [a.name, a.number, a.templates[0].name]), [['A', '96650111', 'RIYADH OFFICE']])
    await giveAgent(db, { name: 'A', number: '96650111', templates: [tpl] })
    assert.equal((await db('cv_templates')).length, 1)
    assert.equal((await agentList(db)).length, 1)
    assert.equal(await giveTemplate(db, tpl), 1)
    await assert.rejects(giveTemplate(db, { name: 'X' }), /no content/)
  } finally { await db.destroy() }
})

test('taken back: not listed and frees a place, given again: same agent', async () => {
  const db = await fresh()
  try {
    await setAgentLimit(db, 1)
    await giveAgent(db, { name: 'A', number: '1' })
    assert.equal((await takeAgent(db, '1')).length, 0)
    await giveAgent(db, { name: 'B', number: '2' })
    await assert.rejects(giveAgent(db, { name: 'A', number: '1' }), /plan has 1 agent\./)
    assert.equal((await db('whatsapp_agents')).length, 2)
  } finally { await db.destroy() }
})

test('a missing name or number is refused', async () => {
  const db = await fresh()
  try { await assert.rejects(giveAgent(db, { name: '', number: '1' }), /name and a number/); await assert.rejects(giveAgent(db, { name: 'A', number: 'x' }), /name and a number/) }
  finally { await db.destroy() }
})
