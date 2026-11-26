// The other PC drawing a CV: a failed one is skipped at once, nobody is waited for longer than drawing here takes,
// a slower one is not used, a late answer is never written. Fakes for the helper (no network, no browser).
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
const G = await import('../src/services/pdfHelperGuard.js')
const quiet = () => {}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
beforeEach(() => { G._reset(); delete process.env.ADAL_PDF_HELPER_GUARD })

test('a helper that never answers costs one wait (the budget), then is skipped at once', async () => {
  G.recordLocal(100)                                   // drawing here takes ~0.1 s -> budget is the 6 s floor; shrink it for the test
  const t = { v: 0 }; const now = () => t.v
  let attempts = 0, written = false
  const attempt = async (id, ticket) => { attempts++; await sleep(60); if (!ticket.abandoned) written = true }
  // a helper that hangs: fake the clock so the budget elapses at once
  const hang = (id, ticket) => { attempts++; return new Promise(() => {}) }
  const orig = global.setTimeout
  global.setTimeout = (fn, ms, ...a) => orig(fn, ms >= 6000 ? 20 : ms, ...a)   // the 6 s budget becomes 20 ms
  try {
    const t0 = Date.now()
    assert.equal(await G.viaHelper({ pick: async () => 'pc1', attempt: hang, log: quiet, now: Date.now }), false)
    assert.ok(Date.now() - t0 < 1000)
    const t1 = Date.now()
    assert.equal(await G.viaHelper({ pick: async () => 'pc1', attempt, log: quiet, now: Date.now }), false)
    assert.ok(Date.now() - t1 < 50, 'the failed PC is skipped at once')
    assert.equal(attempts, 1)
    assert.equal(written, false)
  } finally { global.setTimeout = orig }
})

test('a helper that answers in time is used; a late answer of an abandoned one is not written', async () => {
  const written = []
  const good = async (id, ticket) => { await sleep(10); if (!ticket.abandoned) written.push(id) }
  assert.equal(await G.viaHelper({ pick: async () => 'pc1', attempt: good, log: quiet }), true)
  assert.deepEqual(written, ['pc1'])
  G._reset()
  const orig = global.setTimeout; global.setTimeout = (fn, ms, ...a) => orig(fn, ms >= 6000 ? 20 : ms, ...a)
  try {
    const slow = async (id, ticket) => { await sleep(120); if (!ticket.abandoned) written.push('late') }
    assert.equal(await G.viaHelper({ pick: async () => 'pc2', attempt: slow, log: quiet }), false)
    await sleep(200)
    assert.deepEqual(written, ['pc1'])                // nothing written by the abandoned one
  } finally { global.setTimeout = orig }
})

test('the budget follows how long drawing here takes (never under 6 s, never over 20 s)', () => {
  assert.equal(G.budgetMs(), 10_000)                   // nothing timed yet
  G.recordLocal(1000); assert.equal(G.budgetMs(), 6_000)
  G._reset(); G.recordLocal(6000); assert.equal(G.budgetMs(), 10_500)
  G._reset(); G.recordLocal(60_000); assert.equal(G.budgetMs(), 20_000)
})

test('a helper slower than drawing here is not used, but looked at again every 8th CV; backoff grows', async () => {
  G.recordLocal(3000)
  let ran = 0
  const slowOk = async () => { ran++; await sleep(5) }
  // make the helper look slow: record its time as 5 s by faking the clock in viaHelper
  let tick = 0; const now = () => (tick += 5000)
  assert.equal(await G.viaHelper({ pick: async () => 'pc1', attempt: slowOk, log: quiet, now }), true)   // first try: no history, used
  assert.equal(G.skipReason('pc1', 1e15), 'slower than drawing here')   // (this check counts as one skip)
  let used = 0
  for (let i = 0; i < 16; i++) if (await G.viaHelper({ pick: async () => 'pc1', attempt: slowOk, log: quiet, now: Date.now })) used++
  assert.ok(used >= 1 && used <= 3, `used ${used} of 16`)   // only the occasional re-check
  // nobody offered: not asked again for a minute
  G._reset(); let asked = 0
  await G.viaHelper({ pick: async () => { asked++; return '' }, attempt: async () => {}, log: quiet })
  await G.viaHelper({ pick: async () => { asked++; return '' }, attempt: async () => {}, log: quiet })
  assert.equal(asked, 1)
})

test('ADAL_PDF_HELPER_GUARD=0 brings the old behaviour back (always tried, no skipping)', async () => {
  process.env.ADAL_PDF_HELPER_GUARD = '0'
  let n = 0
  const bad = async () => { n++; throw new Error('timeout') }
  assert.equal(await G.viaHelper({ pick: async () => 'pc1', attempt: bad, log: quiet }), false)
  assert.equal(await G.viaHelper({ pick: async () => 'pc1', attempt: bad, log: quiet }), false)
  assert.equal(n, 2)
})
