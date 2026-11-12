/**
 * Musaned says an employer chose her (through one agent's Saudi office): the
 * agent whose office matches keeps her CV ("chosen here"); at every other
 * agent her CV is deleted for everyone, or — too old to delete — answered
 * "SELECTED"; a WhatsApp that is off does it later. No real WhatsApp: a fake
 * one records what would be done.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'
import { onChosen, officeMatches } from '../src/services/whatsapp.js'

async function fresh() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('musaned_pro'); t.string('chosen_at') })
  await db.schema.createTable('whatsapp_agents', t => { t.increments('id'); t.string('name'); t.string('chat_id'); t.string('musaned_office'); t.integer('active') })
  await db.schema.createTable('whatsapp_sends', t => { t.increments('id'); t.integer('profile_id'); t.integer('agent_id'); t.integer('template_id'); t.string('chat_id'); t.string('message_id'); t.string('status'); t.text('error'); t.string('sent_at'); t.string('closed_at'); t.string('user_key') })
  return db
}

/** A fake WhatsApp: each message id says what WhatsApp would allow ('deleted' | 'kept' | 'missing'). */
function fakeWhatsApp(outcomes) {
  const did = { deleted: [], said: [] }
  const client = {
    pupPage: { evaluate: async (fn, id) => { if (id === undefined) return undefined; const r = outcomes[id] || 'missing'; if (r === 'deleted') did.deleted.push(id); return r } },
    sendMessage: async (chat, text, opts) => { did.said.push({ chat, text, quoted: opts?.quotedMessageId || null }) },
  }
  return { client, did }
}

test('the agent whose office chose her keeps it; the others lose her CV', async () => {
  const db = await fresh()
  try {
    await db('profiles').insert({ id: 1, full_name: 'AMINA ALI', musaned_pro: 'AL-NAJM RECRUITMENT OFFICE', chosen_at: '2026-11-12T08:00:00Z' })
    await db('whatsapp_agents').insert([
      { id: 1, name: 'Najm (Riyadh)', chat_id: 'a1@c.us', musaned_office: 'Al Najm Recruitment', active: 1 },
      { id: 2, name: 'Other office', chat_id: 'a2@c.us', musaned_office: 'Sahara Office', active: 1 },
      { id: 3, name: 'Old chat', chat_id: 'a3@c.us', musaned_office: 'Jeddah Star', active: 1 },
      { id: 4, name: 'Gone message', chat_id: 'a4@c.us', musaned_office: '', active: 1 },
    ])
    await db('whatsapp_sends').insert([
      { profile_id: 1, agent_id: 1, chat_id: 'a1@c.us', message_id: 'm1', status: 'sent', sent_at: '2026-11-01' },
      { profile_id: 1, agent_id: 2, chat_id: 'a2@c.us', message_id: 'm2', status: 'sent', sent_at: '2026-11-01' },
      { profile_id: 1, agent_id: 3, chat_id: 'a3@c.us', message_id: 'm3', status: 'sent', sent_at: '2026-10-01' },
      { profile_id: 1, agent_id: 4, chat_id: 'a4@c.us', message_id: 'm4', status: 'sent', sent_at: '2026-10-01' },
    ])
    const { client, did } = fakeWhatsApp({ m2: 'deleted', m3: 'kept', m4: 'missing' })
    await onChosen(db, 1, { clientOf: () => client })
    const st = Object.fromEntries((await db('whatsapp_sends').select('agent_id', 'status')).map(r => [r.agent_id, r.status]))
    assert.deepEqual(st, { 1: 'chosen_here', 2: 'withdrawn', 3: 'marked', 4: 'marked' })
    assert.deepEqual(did.deleted, ['m2'])                            // deleted for everyone where WhatsApp allows it
    assert.equal(did.said.find(x => x.chat === 'a3@c.us').quoted, 'm3') // too old: "SELECTED" under her CV
    assert.match(did.said.find(x => x.chat === 'a4@c.us').text, /AMINA ALI is no longer available/) // her CV gone: said by name
    assert.ok(!did.said.some(x => x.chat === 'a1@c.us'))             // nothing said to the agent who chose her
  } finally { await db.destroy() }
})

test('its WhatsApp off: nothing changes now, it is done when it is back', async () => {
  const db = await fresh()
  try {
    await db('profiles').insert({ id: 1, full_name: 'B', musaned_pro: 'X OFFICE', chosen_at: '2026-11-12' })
    await db('whatsapp_agents').insert({ id: 2, name: 'Other', chat_id: 'a2@c.us', musaned_office: 'Y', active: 1 })
    await db('whatsapp_sends').insert({ profile_id: 1, agent_id: 2, chat_id: 'a2@c.us', message_id: 'm2', status: 'sent', sent_at: '2026-11-01' })
    await onChosen(db, 1, { clientOf: () => null })
    assert.equal((await db('whatsapp_sends').first()).status, 'sent')
    const { client } = fakeWhatsApp({ m2: 'deleted' })
    await onChosen(db, 1, { clientOf: () => client })
    assert.equal((await db('whatsapp_sends').first()).status, 'withdrawn')
  } finally { await db.destroy() }
})

test('not chosen: nothing is touched', async () => {
  const db = await fresh()
  try {
    await db('profiles').insert({ id: 1, full_name: 'C', musaned_pro: '', chosen_at: null })
    await db('whatsapp_sends').insert({ profile_id: 1, agent_id: 2, message_id: 'm', status: 'sent' })
    let asked = false
    await onChosen(db, 1, { clientOf: () => { asked = true; return null } })
    assert.equal(asked, false)
    assert.equal((await db('whatsapp_sends').first()).status, 'sent')
  } finally { await db.destroy() }
})

test('office names match loosely (spaces, dashes, words around)', () => {
  assert.ok(officeMatches('Al Najm Recruitment', 'AL-NAJM RECRUITMENT OFFICE'))
  assert.ok(!officeMatches('Sahara', 'AL-NAJM RECRUITMENT OFFICE'))
  assert.ok(!officeMatches('', 'ANY'))
})
