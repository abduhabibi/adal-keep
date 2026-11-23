/**
 * Adal Keep Admin → Overview, search, one agency's page, Releases and the live
 * stream (adal-admin/home.mjs), on the pretend Supabase (adal-admin/tests/demo.mjs).
 * The click-every-button sweep in a headless browser: adal-admin/tests/sweep.mjs.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let demo
const get = async (p) => { const r = await fetch(demo.base + p, { headers: { cookie: demo.cookie } }); return { status: r.status, json: await r.json().catch(() => null) } }

before(async () => { demo = await (await import(pathToFileURL(path.join(REPO, 'adal-admin', 'tests', 'demo.mjs')).href)).startDemo() })
after(() => demo?.stop())

test('the Overview says what needs Adal, most urgent first, with where each leads', async () => {
  const { status, json: h } = await get('/api/home')
  assert.equal(status, 200, JSON.stringify(h))
  assert.equal(h.agencies.total, 6)
  assert.equal(h.ok, false)
  assert.ok(h.pcs.total >= 8 && h.pcs.red >= 1, JSON.stringify(h.pcs))
  assert.ok(h.robots.today.done > 0 && h.robots.today.success > 0 && h.robots.today.success <= 100)
  assert.equal(h.tickets.open, 2)
  assert.equal(h.renewals.receipts, 1)
  assert.equal(h.release.short, 'a1b2c3d'); assert.equal(h.release.stage, 'pct'); assert.equal(h.release.went_back, 1)
  assert.ok(h.needs.some(n => n.go === 'releases' && /LUCY-FRONT/.test(n.text)))
  assert.ok(h.needs.every(n => typeof n.go === 'string' && n.go))
  const abay = h.agencies.list.find(a => a.name === 'Abay Manpower')
  assert.equal(abay.light, 'red'); assert.equal(abay.current, false)
})

test('one search finds agencies, PCs, candidates by name or passport, and tickets', async () => {
  const kinds = async (q) => (await get('/api/search?q=' + encodeURIComponent(q))).json.results.map(r => `${r.kind}:${r.title}`)
  assert.ok((await kinds('habesha')).includes('agency:Habesha Recruitment'))
  assert.ok((await kinds('LUCY-FRONT')).includes('pc:LUCY-FRONT'))
  assert.ok((await kinds('EP1002003')).includes('candidate:Tigist Haile'))
  assert.ok((await kinds('Musaned robot stops')).some(k => k.startsWith('ticket:')))
  assert.deepEqual((await get('/api/search?q=x')).json.results, [])
})

test("an agency's page has its PCs, staff, licence, setup, tickets, robots and version", async () => {
  const { status, json: m } = await get('/api/agency/more?pc=200002')
  assert.equal(status, 200, JSON.stringify(m))
  assert.deepEqual(m.pcs.map(p => p.name).sort(), ['HABESHA-DESK2', 'HABESHA-MAIN'])
  assert.ok(m.pcs.every(p => p.current))
  assert.equal(m.staff.length, 3)
  assert.equal(m.tickets.filter(t => t.status === 'open').length, 1)
  assert.ok(m.robots.week.done > 0)
  assert.equal(m.setup.version, 2); assert.equal(m.setup.email, 'office@habesha.et')
  assert.ok(m.billing.renewal.state)
  assert.equal((await get('/api/agency/more?pc=999999')).status, 500)
})

test('Releases: stage, history, which PC runs which version, the PCs that went back', async () => {
  const { json: r } = await get('/api/releases')
  assert.equal(r.release.stage, 'pct')
  assert.deepEqual(r.history.map(h => h.short), ['a1b2c3d', '0f9e8d7'])
  const v = Object.fromEntries(r.versions.map(x => [x.v, x.n]))
  assert.equal(v.a1b2c3d, 6); assert.equal(v['0f9e8d7'], 2)
  assert.equal(r.undone[0].pc, 'LUCY-FRONT')
})

test('the live stream says "changed" when Supabase changed, without a reload', async () => {
  const ac = new AbortController()
  const r = await fetch(demo.base + '/api/live', { headers: { cookie: demo.cookie }, signal: ac.signal })
  const reader = r.body.getReader(); const dec = new TextDecoder()
  let text = ''
  // One read at a time: a read given up on would swallow the next chunk.
  let pending = null
  const until = async (re, ms) => {
    const end = Date.now() + ms
    while (!re.test(text) && Date.now() < end) {
      pending ||= reader.read().then(r => { pending = null; return r })
      const r = await Promise.race([pending, new Promise(ok => setTimeout(() => ok(null), 500))])
      if (r?.done) break
      if (r?.value) text += dec.decode(r.value)
    }
    return re.test(text)
  }
  assert.ok(await until(/"t":"hello"/, 3000), text)
  await new Promise(ok => setTimeout(ok, 4500))   // the first look sets the mark
  const row = demo.fake.tables.keep_meta.find(x => x.key === '/_pc')
  row.updated_at = new Date(Date.now() + 1000).toISOString()
  assert.ok(await until(/"t":"changed"/, 9000), text)
  ac.abort()
})
