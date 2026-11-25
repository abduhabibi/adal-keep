import test from 'node:test'
import assert from 'node:assert/strict'

test('a kept list is answered from memory, and made again the moment its table changes', async () => {
  const { default: express } = await import('express')
  const { default: knex } = await import('knex')
  const { answerCache } = await import('../src/services/answerCache.js')
  const { watchChanges } = await import('../src/services/changes.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name') })
  await db('profiles').insert({ full_name: 'A' })
  watchChanges(db)
  let made = 0
  const app = express()
  app.use(answerCache())
  app.get('/api/profiles', async (req, res) => { made++; res.json(await db('profiles').select('*')) })
  const server = app.listen(0)
  const url = `http://127.0.0.1:${server.address().port}/api/profiles`
  const names = async () => (await (await fetch(url)).json()).map(p => p.full_name)

  assert.deepEqual(await names(), ['A'])
  assert.deepEqual(await names(), ['A'])
  assert.equal(made, 1)                                  // the second came from memory
  await db('profiles').insert({ full_name: 'B' })
  await new Promise(r => setTimeout(r, 900))             // the change is told within a second
  assert.deepEqual(await names(), ['A', 'B'])
  assert.equal(made, 2)
  assert.equal((await (await fetch(url + '?q=A')).json()).length, 2)
  assert.equal(made, 3)                                  // a search is always fresh
  server.close()
  await db.destroy()
})

async function served(make) {
  const { default: express } = await import('express')
  const { answerCache, forget } = await import('../src/services/answerCache.js')
  forget('/api/dashboard')
  const app = express()
  app.use(answerCache())
  app.get('/api/dashboard', make)
  const server = app.listen(0)
  return { url: `http://127.0.0.1:${server.address().port}/api/dashboard`, forget, close: () => server.close() }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms))

test('six windows asking at once for a list just changed: it is made once', async () => {
  let made = 0
  const s = await served(async (req, res) => { made++; await wait(60); res.json({ made, big: 'x'.repeat(30000) }) })
  const all = await Promise.all([...Array(6)].map(() => fetch(s.url).then(r => r.json())))
  assert.equal(made, 1)
  assert.ok(all.every(a => a.made === 1 && a.big.length === 30000))
  s.close()
})

test('a list made while its table changed is not kept, and a later ask does not wait for it', async () => {
  let made = 0, value = 'old', release
  const s = await served(async (req, res) => { const mine = value, n = ++made; if (n === 1) await new Promise(r => { release = r }); res.json({ value: mine }) })
  const first = fetch(s.url).then(r => r.json())
  while (!release) await wait(5)
  value = 'new'; s.forget('/api/dashboard')
  assert.equal((await (await fetch(s.url)).json()).value, 'new')
  release(); await first
  assert.equal((await (await fetch(s.url)).json()).value, 'new')   // the old one did not come back
  s.close()
})

test('the one making it fails or goes away: the others make it themselves', async () => {
  let made = 0
  const s = await served(async (req, res) => { const n = ++made; await wait(40); if (n === 1) return res.status(500).json({ error: 'x' }); res.json({ ok: true }) })
  const codes = (await Promise.all([...Array(3)].map(() => fetch(s.url)))).map(r => r.status).sort()
  assert.deepEqual(codes, [200, 200, 500])
  s.forget('/api/dashboard'); made = 0
  const gone = new AbortController()
  const a = fetch(s.url, { signal: gone.signal }).catch(() => null)
  await wait(10); const b = fetch(s.url); await wait(5); gone.abort(); await a
  assert.equal((await b).status, 200)
  s.close()
})

test('a big list goes packed, made and packed once', async () => {
  const s = await served(async (req, res) => res.json({ big: 'x'.repeat(30000) }))
  for (let i = 0; i < 2; i++) {
    const r = await fetch(s.url, { headers: { 'accept-encoding': 'gzip' } })
    assert.equal(r.headers.get('content-encoding'), 'gzip')
    assert.equal((await r.json()).big.length, 30000)
  }
  const plain = await fetch(s.url, { headers: { 'accept-encoding': 'identity' } })
  assert.equal(plain.headers.get('content-encoding'), null)
  s.close()
})
