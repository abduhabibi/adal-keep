import test from 'node:test'
import assert from 'node:assert/strict'

test('every write is noticed once, by table; bookkeeping is not', async () => {
  const { default: knex } = await import('knex')
  const { watchChanges, onChanged } = await import('../src/services/changes.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('notes') })
  await db.schema.createTable('activity_log', t => { t.increments('id'); t.string('x') })
  watchChanges(db)
  const heard = []
  const off = onChanged(c => heard.push(c.tables))
  await db('profiles').insert({ notes: 'a' })
  await db('profiles').where('id', 1).update({ notes: 'b' })
  await db('activity_log').insert({ x: 'quiet' })
  await db('profiles').select('*')               // reads are not changes
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual(heard, [['profiles']])         // three writes, one message
  await db('profiles').where('id', 1).del()
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual(heard[1], ['profiles'])
  off()
  await db.destroy()
})

test('opening a profile is not told to everyone (only its last_opened_at changes)', async () => {
  const { default: knex } = await import('knex')
  const { watchChanges, onChanged } = await import('../src/services/changes.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('notes'); t.string('last_opened_at') })
  await db('profiles').insert({ notes: 'a' })
  watchChanges(db)
  const heard = []
  const off = onChanged(c => heard.push(c.tables))
  await new Promise(r => setTimeout(r, 900)); heard.length = 0
  await db('profiles').where('id', 1).update({ last_opened_at: new Date().toISOString() })
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual(heard, [])
  await db('profiles').where('id', 1).update({ notes: 'b' })
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual(heard, [['profiles']])
  off(); await db.destroy()
})

test('an audit line (written at each look at a girl) goes to the other PCs, the windows are not told', async () => {
  const { default: knex } = await import('knex')
  const { watchChanges, onChanged, onShown } = await import('../src/services/changes.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('audit_log', t => { t.increments('id'); t.string('who') })
  await db.schema.createTable('notes', t => { t.increments('id'); t.string('x') })
  watchChanges(db)
  await new Promise(r => setTimeout(r, 900))
  const all = [], shown = []
  const offs = [onChanged(c => all.push(...c.tables)), onShown(c => shown.push(...c.tables))]
  await db('audit_log').insert({ who: 'A' })
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual([all, shown], [['audit_log'], []])
  await db('audit_log').insert({ who: 'B' }); await db('notes').insert({ x: 'a' })
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual(shown, ['notes'])
  offs.forEach(f => f()); await db.destroy()
})

test('a change made on this page: its own reloads run at once, the timers once (by the PC\'s word while it is live)', async () => {
  globalThis.window = { __adalLiveUp: true }; globalThis.document = { hidden: false }
  const { onDataChange, setRefreshAll, tellChanged } = await import('../../adal-keep-frontend/src/lib/changes.js')
  let timers = 0, page = 0
  setRefreshAll(() => timers++)
  const off = onDataChange(['profiles'], () => page++, 10)
  tellChanged(['profiles'], { mine: true })
  await new Promise(r => setTimeout(r, 400))
  assert.deepEqual([page, timers], [1, 0])
  tellChanged(['profiles'])                        // the PC's word
  await new Promise(r => setTimeout(r, 400))
  assert.deepEqual([page, timers], [2, 1])
  window.__adalLiveUp = false                      // no live link: this page runs them itself
  tellChanged(['profiles'], { mine: true })
  await new Promise(r => setTimeout(r, 2200))
  assert.equal(timers, 2)
  off(); delete globalThis.window; delete globalThis.document
})

test('a change runs only the timers that show its tables; what is not known runs always', async () => {
  const fs = await import('fs')
  const src = fs.readFileSync(new URL('../../adal-keep-frontend/src/lib/changes.js', import.meta.url), 'utf8')
  const part = src.slice(src.indexOf('const QUEUE ='), src.indexOf('let refreshAll'))
  const { concerns } = await import('data:text/javascript,' + encodeURIComponent(`const off = () => false\n${part}`))
  const c = (urls, tables) => concerns(new Set(urls), tables)
  assert.equal(c(['/profiles/brief'], ['tasks']), false)
  assert.equal(c(['/profiles/brief'], ['profiles']), true)
  assert.equal(c(['/automations/stages'], ['generated_cvs']), true)
  assert.equal(c(['/subscription/status'], ['profiles', 'tasks']), false)     // not from the database
  assert.equal(c(['/subscription/status', '/tasks/count'], ['tasks']), true)
  assert.equal(c(['/something/new'], ['tasks']), true)
  assert.equal(c(['/profiles/7/automations'], ['tasks']), false)
  assert.equal(c(['/profiles/7/automations'], ['anything_else']), true)
  assert.equal(c([], ['tasks']), true)
  assert.equal(c(['/profiles/brief'], ['*']), true)
})
