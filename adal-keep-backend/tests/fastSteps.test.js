// Robot steps that wait for what they need, not for a fixed time (ADAL_FAST_STEPS=0 brings the old waits back). The helpers are tested
// alone; three Musaned steps run in a headless Chrome of their own against mock pages (nothing reaches a real site) with the switch off
// (before) and on (after); the times are printed. Skipped without Chrome.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { findChrome } from './helpers/chrome.js'

const F = await import('../src/services/fastSteps.js')
const W = await import('../src/services/musanedWorkflow.js')
const CHROME = findChrome()
const took = async (fn) => { const t = Date.now(); const r = await fn(); return { ms: Date.now() - t, r } }

test('settle ends when ready, and waits the whole time when it never is; the switch brings the old wait back', async () => {
  let n = 0
  const a = await took(() => F.settle(2000, () => ++n >= 3))
  assert.equal(a.r, true); assert.ok(a.ms < 600, `${a.ms} ms`)
  const b = await took(() => F.settle(400, () => false))
  assert.equal(b.r, false); assert.ok(b.ms >= 390)                                // never ready: the old time, the step's own check decides
  const e = await took(() => F.settle(300, () => { throw new Error('page gone') }))
  assert.ok(e.ms >= 290)                                                          // an error is "not ready", never thrown
  process.env.ADAL_FAST_STEPS = '0'
  try { const c = await took(() => F.settle(400, () => true)); assert.ok(c.ms >= 390, 'off: the fixed wait'); assert.equal(F.pollFor(1000), 1000) } finally { delete process.env.ADAL_FAST_STEPS }
  assert.equal(F.pollFor(1000), 333); assert.equal(F.pollFor(500), 167); assert.equal(F.pollFor(2000), 400); assert.equal(F.pollFor(300), 150)
})

test('pollUntil: the old loop with a short poll — found, never found, and the same longest wait', async () => {
  let n = 0
  const a = await took(() => F.pollUntil(() => ++n >= 3, 5000, 1000))
  assert.equal(a.r.ok, true); assert.ok(a.ms < 1200, `${a.ms} ms`)                // 3 looks at 333 ms, not 3 s
  const b = await took(() => F.pollUntil(() => false, 1000, 1000))
  assert.equal(b.r.ok, false); assert.ok(b.ms >= 900 && b.ms < 1500)
  process.env.ADAL_FAST_STEPS = '0'
  try { n = 0; const c = await took(() => F.pollUntil(() => ++n >= 2, 5000, 400)); assert.ok(c.ms >= 390 && c.ms < 900) } finally { delete process.env.ADAL_FAST_STEPS }
})

async function browser() {
  const puppeteer = (await import('puppeteer-core')).default
  return puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
}
const ctx = { log: () => {}, notify: async () => {} }

test('Musaned: Go to dashboard → HR Pool → Add New Candidate on a mock site (before / after)', { skip: !CHROME && 'no Chrome here', timeout: 120000 }, async () => {
  // A single-page app, like Musaned: the dashboard menu shows 300 ms after the click, the HR Pool link swaps the content (no page load),
  // its "Add New Candidate" shows 250 ms later and opens the form (an ID Number box) 200 ms after its click.
  const PAGE = `<button id="g">Go to Dashboard</button><script>
    const add = (html) => document.body.insertAdjacentHTML('beforeend', html)
    document.getElementById('g').onclick = () => setTimeout(() => {
      add('<nav><a id="hp" href="/hr-pool">HR Pool</a></nav>')
      document.getElementById('hp').onclick = (e) => { e.preventDefault(); history.pushState({}, '', '/hr-pool'); document.body.innerHTML = '<h1>Candidates</h1>'
        setTimeout(() => { add('<button id="an">ADD NEW CANDIDATE</button>'); document.getElementById('an').onclick = () => setTimeout(() => add('<input placeholder="ID Number">'), 200) }, 250) }
    }, 300)
  </script>`
  const site = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE) })
  await new Promise(r => site.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${site.address().port}/`
  const b = await browser()
  const run = async () => {
    const page = await b.newPage(); await page.goto(url)
    const t0 = Date.now(), t = {}
    await W.stepClickGoToDashboard(page, ctx); t.dashboard = Date.now() - t0
    const t1 = Date.now(); await W.stepClickHrPool(page, ctx); t.hrPool = Date.now() - t1
    const t2 = Date.now(); const r = await W.stepClickAddNewCandidate(page, ctx); t.addNew = Date.now() - t2
    assert.equal(r.ok, true)
    await page.close(); return t
  }
  try {
    process.env.ADAL_FAST_STEPS = '0'; const before = await run(); delete process.env.ADAL_FAST_STEPS
    const after = await run()
    console.log(`  Go to Dashboard  before ${before.dashboard} ms  after ${after.dashboard} ms\n  HR Pool          before ${before.hrPool} ms  after ${after.hrPool} ms\n  Add New Candidate before ${before.addNew} ms  after ${after.addNew} ms`)
    assert.ok(before.dashboard >= 2500); assert.ok(after.dashboard < 1200, 'the dashboard wait ends when its menu shows')
    assert.ok(after.hrPool + after.addNew < before.hrPool + before.addNew - 1000)
  } finally { delete process.env.ADAL_FAST_STEPS; await b.close(); site.close() }
})

test('Musaned: finding her passport in our HR Pool list on a mock site that never goes quiet (before / after)', { skip: !CHROME && 'no Chrome here', timeout: 150000 }, async () => {
  const PP = 'EP1234567'
  const HR = (inList) => `<!doctype html><body><app-filter-search><button class="app-filter-header">Passport Number</button><div id="box"></div></app-filter-search><div id="rows"></div><script>
    // three requests the site keeps open for 9 s, then a notifications poll: "quiet" comes late, as on the real site
    for (let i = 0; i < 3; i++) fetch('/api/hang').catch(() => {})
    setInterval(() => fetch('/api/notifications').catch(() => {}), 400)
    document.querySelector('.app-filter-header').onclick = () => setTimeout(() => { const i = document.createElement('textarea'); document.getElementById('box').appendChild(i)
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') setTimeout(() => { document.getElementById('rows').innerHTML = ${inList ? `'<div>PASSPORT NUMBER ' + i.value + ' <a>VIEW</a></div>'` : "'<div>No data</div>'"} }, 350) })
    }, 150)
  </script></body>`
  const b = await browser()
  const one = async (inList) => {
    const page = await b.newPage(); await page.setRequestInterception(true)
    page.on('request', (req) => {
      const u = new URL(req.url())
      if (u.hostname !== 'tawtheeq.musaned.com.sa') return req.abort().catch(() => {})
      if (u.pathname === '/hr-pool') return req.respond({ status: 200, contentType: 'text/html', body: HR(inList) }).catch(() => {})
      if (u.pathname === '/api/hang') return void setTimeout(() => req.respond({ status: 200, contentType: 'application/json', body: '{}' }).catch(() => {}), 9000)
      req.respond({ status: 200, contentType: 'application/json', body: '{}' }).catch(() => {})
    })
    const t = Date.now(); const found = await W._findInOurList(page, ctx, PP); const ms = Date.now() - t
    await page.close(); return { found, ms }
  }
  try {
    process.env.ADAL_FAST_STEPS = '0'; const before = { yes: await one(true), no: await one(false) }; delete process.env.ADAL_FAST_STEPS
    const after = { yes: await one(true), no: await one(false) }
    console.log(`  in our list      before ${before.yes.ms} ms (${before.yes.found})  after ${after.yes.ms} ms (${after.yes.found})\n  not in our list  before ${before.no.ms} ms (${before.no.found})  after ${after.no.ms} ms (${after.no.found})`)
    assert.equal(before.yes.found, true); assert.equal(after.yes.found, true)       // the same answers
    assert.equal(before.no.found, false); assert.equal(after.no.found, false)
    assert.ok(after.yes.ms < before.yes.ms - 3000, 'found: no waiting for the quiet network')
    assert.ok(after.no.ms <= before.no.ms, '"not found" is not slower (its answer still waits for the quiet network, as before)')
  } finally { delete process.env.ADAL_FAST_STEPS; await b.close() }
})
