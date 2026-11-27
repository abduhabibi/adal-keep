// The five scenarios of "the robot brain runs on every PC, and Main can be off". They only use the adapter's methods and the mock site's
// visit log, so the same scenarios run on the reference brain and on the real code (scripts/brain/real.mjs).
import { LEASE_MS } from './reference.mjs'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(30) } return false }
const check = (ok, what, got) => { if (!ok) throw new Error(`${what}${got !== undefined ? ` (got ${JSON.stringify(got)})` : ''}`) }
const pcsOf = (site, g) => site.started(g).map(v => v.pc)

export const SCENARIOS = [
  ['1. Main on: a run goes to the faster PC', async (b, site) => {
    await b.addPC('Main', { strength: 3, main: true, runMs: 200 }); await b.addPC('Comp', { strength: 1, runMs: 600 })
    await b.enqueue('Comp', 101)                                   // a person starts it in the Companion's window
    check(await waitFor(() => site.ended(101).length), 'the run finished')
    check(JSON.stringify(pcsOf(site, 101)) === '["Main"]', 'it ran once, on the faster PC (Main)', pcsOf(site, 101))
    await b.enqueue('Main', 102)                                   // and the other way round: the Companion is stronger now
    await b.addPC('Fast', { strength: 9, runMs: 150 })
    await b.enqueue('Comp', 103)
    check(await waitFor(() => site.ended(103).length), 'the second run finished')
    check(JSON.stringify(pcsOf(site, 103)) === '["Fast"]', 'a stronger PC that joins gets the next run', pcsOf(site, 103))
    check(site.started(102).length === 1, 'every run started once', site.started(102).length)
  }],
  ['2. Main off: the Companion runs a girl by itself; the result reaches Main when it returns', async (b, site) => {
    await b.addPC('Main', { strength: 3, main: true, runMs: 200 }); await b.addPC('Comp', { strength: 1, runMs: 300 })
    await b.off('Main')
    await b.enqueue('Comp', 201)
    check(await waitFor(() => site.ended(201).length), 'the Companion ran her with Main off')
    check(JSON.stringify(pcsOf(site, 201)) === '["Comp"]', 'on the Companion', pcsOf(site, 201))
    check(!(await b.results('Main')).length, 'Main knows nothing yet')
    await b.on('Main')
    check(await waitFor(async () => (await b.results('Main')).some(r => r.key === '201:musaned_check_chosen' && r.status === 'done')), 'the result reached Main when it came back', await b.results('Main'))
    check(site.started(201).length === 1, 'she was not run again', site.started(201).length)
  }],
  ['3. Both PCs try the same girl: only one runs her', async (b, site) => {
    await b.addPC('Main', { strength: 3, main: true, runMs: 500 }); await b.addPC('Comp', { strength: 3, runMs: 500 })
    await Promise.all([b.enqueue('Main', 301), b.enqueue('Comp', 301)])
    check(await waitFor(() => site.ended(301).length), 'one run finished')
    await sleep(LEASE_MS)
    check(site.started(301).length === 1, 'the site saw ONE visit for her', pcsOf(site, 301))
    const rows = [...(await b.rows('Main')), ...(await b.rows('Comp'))]
    check(rows.some(r => r.status === 'skipped' || r.status === 'handed'), 'the other request says why it did not run', rows.map(r => r.status))
  }],
  ['4. A PC dies mid-run: the lease expires, nothing retries by itself, a person can start her again', async (b, site) => {
    await b.addPC('Main', { strength: 1, main: true, runMs: 300 }); await b.addPC('Comp', { strength: 5, runMs: 1600 })
    await b.enqueue('Comp', 401)
    check(await waitFor(() => site.started(401).length), 'the Companion started her')
    await b.off('Comp')                                            // it dies mid-run
    check(await waitFor(async () => (await b.claims('Main')).some(c => c.key.startsWith('401:') && c.state === 'expired'), LEASE_MS * 6), 'her claim expired on Main after the lease', await b.claims('Main'))
    await sleep(LEASE_MS * 3)
    check(site.started(401).length === 1 && !site.ended(401).length, 'nothing started her again by itself (one agent, one try)', site.visits.filter(v => v.girl === '401'))
    await b.enqueue('Main', 401, { pinned: true })                 // a person presses Start
    check(await waitFor(() => site.ended(401).length), 'the person\'s Start ran her')
    check(JSON.stringify(pcsOf(site, 401)) === '["Comp","Main"]', 'one aborted visit then one fresh run', pcsOf(site, 401))
  }],
  ['5. Network cut between the PCs: each runs only its own queue', async (b, site) => {
    await b.addPC('Main', { strength: 3, main: true, runMs: 250 }); await b.addPC('Comp', { strength: 9, runMs: 250 })
    b.cut('Main', 'Comp')
    await b.enqueue('Main', 501); await b.enqueue('Comp', 502)
    check(await waitFor(() => site.ended(501).length && site.ended(502).length), 'both ran')
    check(JSON.stringify(pcsOf(site, 501)) === '["Main"]' && JSON.stringify(pcsOf(site, 502)) === '["Comp"]', 'each ran its own, though the other PC is stronger / weaker', [pcsOf(site, 501), pcsOf(site, 502)])
    b.heal('Main', 'Comp')
    check(await waitFor(async () => { const r = (await b.results('Main')).map(x => x.key).sort(); return r.length >= 2 }), 'after the link is back Main holds both results', await b.results('Main'))
    check(site.started(501).length === 1 && site.started(502).length === 1, 'nobody ran the other\'s girl', site.visits.length)
  }],
]
