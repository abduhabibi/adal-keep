/**
 * "Wakala not paid" reaches the phones once every 3 days a girl at most — also
 * after her task and her notification were cleared (each Musaned scan used to
 * ask again, every few minutes).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'
import { askToPay } from '../src/services/wakala.js'

test('a girl is asked about once, even when her task and notification are cleared', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  try {
    await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('musaned_pro'); t.string('chosen_at'); t.string('musaned_payment'); t.string('passport_number'); t.string('contract_number') })
    await db.schema.createTable('whatsapp_agents', t => { t.increments('id'); t.string('name'); t.string('chat_id'); t.string('musaned_office') })
    await db.schema.createTable('whatsapp_sends', t => { t.increments('id'); t.integer('profile_id'); t.integer('agent_id'); t.string('status') })
    await db.schema.createTable('tasks', t => { t.increments('id'); t.string('type'); t.string('title'); t.text('description'); t.string('status'); t.integer('profile_id'); t.integer('assigned_to'); t.boolean('is_ai_created'); t.string('created_at'); t.text('payload') })
    await db.schema.createTable('notifications', t => { t.increments('id'); t.string('type'); t.string('title'); t.text('body'); t.string('created_day'); t.datetime('created_at').defaultTo(db.fn.now()) })
    await db.schema.createTable('settings', t => { t.increments('id'); t.string('key').unique(); t.text('value'); t.datetime('updated_at') })
    await db('profiles').insert({ id: 1, full_name: 'UMER', chosen_at: '2026-11-10', musaned_payment: 'Unpaid', musaned_pro: 'Office' })

    assert.equal((await askToPay(db, 1)).asked, true)
    assert.equal((await askToPay(db, 1)).asked, false)
    await db('tasks').del(); await db('notifications').del()
    assert.equal((await askToPay(db, 1)).asked, false, 'not again after clearing')
    assert.equal(await db('notifications').count({ n: '*' }).first().then(r => Number(r.n)), 0)
  } finally { await db.destroy() }
})
