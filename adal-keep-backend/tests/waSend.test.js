/** "Send on WhatsApp" and the WhatsApp page: to the picked agents only, asked before a second time, every send kept. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import knex from 'knex'

process.env.ADAL_WHATSAPP = '0'   // (a test never signs in)
const { prepareSend, startSend, retrySend } = await import('../src/services/waSend.js')
const { listSends, acked, lastSent, withWho } = await import('../src/services/waRecords.js')
const { up } = await import('../src/migrations/069_whatsapp_sends_who.js')
const { onChanged } = await import('../src/services/changes.js')
const SAFE = path.join(import.meta.dirname, '..', 'data', 'SafeStorage')

async function makeDb() {
  const db = knex({ client: 'sqlite3', connection: ':memory:', useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profiles', t => { t.increments('id'); for (const c of ['full_name', 'passport_number', 'chosen_at', 'musaned_stage', 'status', 'work_experience', 'contract_number', 'musaned_pro', 'updated_at']) t.string(c) })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.string('status'); t.string('pause_reason') })
  await db.schema.createTable('whatsapp_agents', t => { t.increments('id'); t.string('name'); t.string('chat_id'); t.text('template_ids'); t.string('musaned_office'); t.boolean('active'); t.string('user_key') })
  await db.schema.createTable('whatsapp_sends', t => { t.increments('id'); t.integer('profile_id'); t.integer('agent_id'); t.integer('template_id'); t.string('chat_id'); t.string('message_id'); t.string('status'); t.text('error'); t.string('sent_at'); t.string('closed_at'); t.string('user_key') })
  await db.schema.createTable('cv_templates', t => { t.increments('id'); t.string('name'); t.boolean('is_active') })
  await db.schema.createTable('generated_cvs', t => { t.increments('id'); t.integer('profile_id'); t.integer('template_id'); t.string('pdf_path'); t.string('filename'); t.string('created_at') })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('path'); t.string('mimetype'); t.string('original_name'); t.integer('size') })
  await up(db); await up(db)   // twice: nothing breaks
  await db('profiles').insert([{ id: 1, full_name: 'HANNA A', passport_number: 'EP1', musaned_stage: 'IN OUR LIST' }, { id: 2, full_name: 'SARA B', passport_number: 'EP2' }])
  await db('whatsapp_agents').insert([{ id: 1, name: 'Riyadh', chat_id: '966500000001@c.us', active: 1 }, { id: 2, name: 'Jeddah', chat_id: 'g1@g.us', active: 1 }, { id: 3, name: 'Old', chat_id: '966500000003@c.us', active: 0 }])
  await db('cv_templates').insert({ id: 5, name: 'GOLD', is_active: 1 })
  return db
}
const name = `wa-test-${process.pid}-${Date.now()}.pdf`
fs.mkdirSync(SAFE, { recursive: true }); fs.writeFileSync(path.join(SAFE, name), '%PDF-1.4 test')
test.after(() => fs.unlinkSync(path.join(SAFE, name)))
const cv = async (db, profile_id = 1) => (await db('generated_cvs').insert({ profile_id, template_id: 5, pdf_path: name }))[0]
const fake = (o = {}) => { const sent = []; return { sent, key: 'k', label: 'test', async send(chat, f) { if (o.fail?.(chat)) throw Object.assign(new Error('no such chat'), o.stop ? { stop: true } : {}); sent.push([chat, f.name, f.caption, fs.existsSync(f.path)]); return `true_${chat}_${sent.length}` } } }
const finish = async (job) => { for (let i = 0; i < 100 && job.running; i++) await new Promise(r => setTimeout(r, 10)); return job }

test('to the picked agents only; kept with who, from where and how far', async () => {
  const db = await makeDb(), t = fake(), id = await cv(db)
  let told = []; const off = onChanged(({ tables }) => { told = told.concat(tables) })
  const ready = await prepareSend(db, { profileId: 1, cvId: id, agentIds: [1, 3] })
  const job = await finish(startSend(db, ready, t, { by: 'Hanna', from: 'PC-2', gap: () => 1 }))
  assert.deepEqual([job.sent, job.failed, job.total], [1, 0, 1], 'the one taken off the agency\'s agents is not sent to')
  assert.deepEqual(t.sent, [['966500000001@c.us', 'HANNA_A_GOLD.pdf', 'HANNA A · EP1', true]])
  const { rows } = await listSends(db)
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].profile_name, rows[0].agent_name, rows[0].sent_by, rows[0].sent_from, rows[0].status, rows[0].ack, rows[0].template_name], ['HANNA A', 'Riyadh', 'Hanna', 'PC-2', 'sent', 1, 'GOLD'])
  await acked(db, 'true_966500000001@c.us_1', 2); await acked(db, 'true_966500000001@c.us_1', 1)
  assert.equal((await listSends(db)).rows[0].ack, 2, 'never back')
  await new Promise(r => setTimeout(r, 900)); off()
  assert.ok(told.includes('whatsapp_log')); assert.ok(!told.includes('whatsapp_sends'))
  await db.destroy()
})

test('a second time is asked, per agent; not in Waiting, chosen, nobody picked or too many: refused before any message', async () => {
  const db = await makeDb(), t = fake(), id = await cv(db)
  await finish(startSend(db, await prepareSend(db, { profileId: 1, cvId: id, agentIds: [1] }), t, { by: 'Hanna', gap: () => 1 }))
  await assert.rejects(prepareSend(db, { profileId: 1, cvId: id, agentIds: [1, 2] }), (e) => e.before.length === 1 && e.before[0].agent === 'Riyadh' && e.before[0].by === 'Hanna' && !!e.before[0].at)
  await finish(startSend(db, await prepareSend(db, { profileId: 1, cvId: id, agentIds: [1, 2], again: [1] }), t, { gap: () => 1 }))
  assert.equal(t.sent.length, 3); assert.equal((await lastSent(db, 1))[1].times, 2)
  await assert.rejects(prepareSend(db, { profileId: 2, cvId: await cv(db, 2), agentIds: [1] }), /not in Waiting/)
  await assert.rejects(prepareSend(db, { profileId: 1, cvId: id, agentIds: [] }), /Pick the agents/)
  await assert.rejects(prepareSend(db, { profileId: 1, cvId: id, agentIds: Array.from({ length: 16 }, (_, i) => i + 1) }), /At most 15/)
  await assert.rejects(prepareSend(db, { profileId: 1, cvId: await cv(db, 2), agentIds: [2], again: [2] }), /not hers/)
  await db('profiles').where('id', 1).update({ chosen_at: '2026-11-01' })
  await assert.rejects(prepareSend(db, { profileId: 1, cvId: id, agentIds: [2], again: [2] }), /already chosen/)
  assert.equal(t.sent.length, 3)
  await db.destroy()
})

test('a failure is kept and retried by a click, on the same line; over the limit stops the rest', async () => {
  const db = await makeDb(), id = await cv(db)
  let down = true; const t = fake({ fail: (c) => down && c === 'g1@g.us' })
  const job = await finish(startSend(db, await prepareSend(db, { profileId: 1, cvId: id, agentIds: [2, 1] }), t, { by: 'H', from: 'PC', gap: () => 1 }))
  assert.deepEqual([job.sent, job.failed], [1, 1])
  const bad = (await listSends(db, { status: 'failed' })).rows
  assert.deepEqual([bad.length, bad[0].error, bad[0].agent_name], [1, 'no such chat', 'Jeddah'])
  await assert.rejects(retrySend(db, bad[0].id, async () => t), /no such chat/)
  down = false
  await retrySend(db, bad[0].id, async () => t, { by: 'Sara', from: 'PC-9' })
  const row = await db('whatsapp_sends').where('id', bad[0].id).first()
  assert.deepEqual([row.status, row.error, row.sent_by, row.sent_from], ['sent', null, 'Sara', 'PC-9'])
  assert.equal((await db('whatsapp_sends')).length, 2)
  await assert.rejects(retrySend(db, bad[0].id, async () => t), /went already/)
  const lim = await finish(startSend(db, await prepareSend(db, { profileId: 1, cvId: id, agentIds: [1, 2], again: [1, 2] }), fake({ fail: () => true, stop: true }), { gap: () => 1 }))
  assert.deepEqual([lim.failed, lim.results.length, lim.done], [2, 2, 2])
  await db.destroy()
})

test('the list: by agent, by girl, older, and only what changed since', async () => {
  const db = await makeDb(), id = await cv(db), t = fake()
  await db('profiles').where('id', 2).update({ musaned_stage: 'IN OUR LIST' })
  await finish(startSend(db, await prepareSend(db, { profileId: 1, cvId: id, agentIds: [1, 2] }), t, { gap: () => 1 }))
  await finish(startSend(db, await prepareSend(db, { profileId: 2, cvId: await cv(db, 2), agentIds: [1] }), t, { gap: () => 1 }))
  assert.equal((await listSends(db, { agent: 1 })).rows.length, 2)
  assert.deepEqual((await listSends(db, { girl: 'sara' })).rows.map(r => r.profile_name), ['SARA B'])
  assert.equal((await listSends(db, { girl: '%' })).rows.length, 0, 'a % is a letter')
  const p1 = await listSends(db, { limit: 2 }); assert.equal(p1.more, true)
  assert.equal((await listSends(db, { before: p1.rows.at(-1).id })).rows.length, 1)
  const all = await listSends(db)
  assert.equal((await listSends(db, { since: all.upto })).rows.length, 0)
  await new Promise(r => setTimeout(r, 5)); await acked(db, t.sent.length && 'true_966500000001@c.us_1', 3)
  assert.deepEqual((await listSends(db, { since: all.upto })).rows.map(r => r.ack), [3])
  assert.equal(await withWho(db), true)
  await db.destroy()
})

test('the page: a line changed stays in its place', async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'adal-keep-frontend', 'src', 'pages', 'WhatsAppSentPage.jsx'), 'utf8')
  const f = new Function(`${src.match(/export function mergeRows[\s\S]*?\n}\n/)[0].replace('export ', '')}; return mergeRows`)()
  assert.deepEqual(f([{ id: 3 }, { id: 1, ack: 1 }], [{ id: 1, ack: 2 }, { id: 9 }]), [{ id: 9 }, { id: 3 }, { id: 1, ack: 2 }])
})
