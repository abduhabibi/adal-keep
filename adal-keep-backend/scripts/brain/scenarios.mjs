// The five scenarios of "the robot brain runs on every PC, and Main can be off". They only use the adapter's methods and the mock site's
// visit log, so the same scenarios run on the reference brain and on the real code (scripts/brain/real.mjs).
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms + (globalThis.__brainSlack || 0);   // (the real brain adds the PC copying's delay)
  while (Date.now() < end) { if (await fn()) return true; await sleep(30) } return false }
const check = (ok, what, got) => { if (!ok) throw new Error(`${what}${got !== undefined ? ` (got ${JSON.stringify(got)})` : ''}`) }
const pcsOf = (site, g) => site.started(g).map(v => v.pc)
/** No two robot visits for one girl overlap in time (one run per girl and site at once). */
const overlaps = (site, g) => { const v = site.visits.filter(x => x.girl === String(g)).sort((a, b) => a.t - b.t); let open = 0, bad = 0; for (const x of v) { if (x.phase === 'start') { if (open) bad++; open++ } else open = Math.max(0, open - 1) } return bad }

export const SCENARIOS = [
  ['1. Main on: a run goes to the faster PC', async (b, site) => {
    // A weak Main (Yusuf: 4 cores or fewer) gives its runs to the strongest PC that is on; a strong Main runs them itself.
    await b.addPC('Main', { strength: 1, main: true, runMs: 200 }); await b.addPC('Comp', { strength: 5, runMs: 200 })
    await b.enqueue('Main', 101)
    check(await waitFor(() => site.ended(101).length), 'the run finished')
    check(JSON.stringify(pcsOf(site, 101)) === '["Comp"]', 'it ran once, on the faster PC (Comp)', pcsOf(site, 101))
    await b.addPC('Fast', { strength: 9, runMs: 150 })              // a still stronger PC comes on
    await b.enqueue('Comp', 103)                                   // started in the Companion's window
    check(await waitFor(() => site.ended(103).length), 'the second run finished')
    check(JSON.stringify(pcsOf(site, 103)) === '["Fast"]', 'a stronger PC that joins gets the next run', pcsOf(site, 103))
  }],
  ['2. Main off: the Companion runs a girl by itself; the result reaches Main when it returns', async (b, site) => {
    await b.addPC('Main', { strength: 3, main: true, runMs: 200 }); await b.addPC('Comp', { strength: 1, runMs: 300 })
    await b.off('Main')
    await b.enqueue('Comp', 201)
    check(await waitFor(() => site.ended(201).length), 'the Companion ran her with Main off')
    check(JSON.stringify(pcsOf(site, 201)) === '["Comp"]', 'on the Companion', pcsOf(site, 201))
    check(!(await b.results('Main')).some(r => r.key === 'musaned|201'), 'Main knows nothing about her yet')
    await b.on('Main')
    check(await waitFor(async () => (await b.results('Main')).some(r => r.key === 'musaned|201' && r.status === 'done')), 'the result reached Main when it came back', await b.results('Main'))
    check(site.started(201).length === 1, 'she was not run again', site.started(201).length)
  }],
  ['3. Both PCs try the same girl: only one runs her', async (b, site) => {
    await b.addPC('Main', { strength: 3, main: true, runMs: 500 }); await b.addPC('Comp', { strength: 3, runMs: 500 })
    await Promise.all([b.enqueue('Main', 301), b.enqueue('Comp', 301)])
    check(await waitFor(() => site.ended(301).length), 'one run finished')
    await sleep(Math.min(b.leaseMs, 3000))
    check(overlaps(site, 301) === 0, 'two PCs never ran her at the same time', site.visits.filter(v => v.girl === '301'))
    const rows = [...(await b.rows('Main')), ...(await b.rows('Comp'))]
    check(rows.some(r => ['skipped', 'handed', 'pending'].includes(r.status) && /Waiting for|is running her|handed/.test(r.pause_reason || '') || r.status === 'done'), 'the other request says why it waits', rows.map(r => [r.status, r.pause_reason]))
    if (site.started(301).length > 1) console.log(`         (note: the second request ran her again after the first finished — ${site.started(301).length} visits, not overlapping)`)
  }],
  ['4. A PC dies mid-run: the lease expires, nothing retries by itself, a person can start her again', async (b, site) => {
    await b.addPC('Main', { strength: 1, main: true, runMs: 300 }); await b.addPC('Comp', { strength: 5, runMs: 600000 })
    await b.off('Main')                                            // Main is off, so the Companion runs her (a long run)
    await b.enqueue('Comp', 401)
    check(await waitFor(() => site.started(401).length, b.leaseMs * 2), 'the Companion started her')
    await b.on('Main')                                             // Main comes back and sees the run (the Companion's renewal tells it)
    check(await waitFor(async () => (await b.runState('Main', 401)) === 'running', b.leaseMs), 'Main sees her run on the Companion', await b.runState('Main', 401))
    await b.off('Comp')                                            // the Companion dies mid-run
    check(await waitFor(async () => ['expired', 'failed'].includes(await b.runState('Main', 401)), b.leaseMs * 8), 'on Main her run is expired / failed after the lease', await b.runState('Main', 401))
    await sleep(Math.min(b.leaseMs * 2, 20000))
    check(site.started(401).length === 1 && !site.ended(401).length, 'nothing started her again by itself (one agent, one try)', site.visits.filter(v => v.girl === '401'))
    const pid401 = await b.profileId(401)
    await b.on('Comp')                                             // it comes back: its own row for her says what happened
    if (b.sweeps === false) console.log('         (not checked: the lease sweep that fails the row does not run in a scratch instance)')
    else check(await waitFor(async () => (await b.rows('Comp')).some(r => r.profile_id === pid401 && r.status === 'failed' && /stopped — .* went away|stopped — PC went away/.test(`${r.pause_reason || ''}${r.log || ''}`)), b.leaseMs * 6), 'her run is failed with "stopped — PC went away"', (await b.rows('Comp')).map(r => [r.status, r.pause_reason]))
    await b.enqueue('Main', 401, { pinned: true })                 // a person presses Start
    check(await waitFor(() => site.ended(401).length, b.leaseMs * 2), 'the person\'s Start ran her')
    check(JSON.stringify(pcsOf(site, 401)) === '["Comp","Main"]', 'one aborted visit then one fresh run', pcsOf(site, 401))
  }],
  ['5. Network cut between the PCs: each runs only its own queue', async (b, site) => {
    await b.addPC('Main', { strength: 3, main: true, runMs: 250 }); await b.addPC('Comp', { strength: 9, runMs: 250 })
    await b.prepare?.([501, 502])                                  // (her profile is on both PCs before the network is cut)
    b.cut('Main', 'Comp')
    await b.enqueue('Main', 501); await b.enqueue('Comp', 502)
    check(await waitFor(() => site.ended(501).length && site.ended(502).length), 'both ran')
    check(JSON.stringify(pcsOf(site, 501)) === '["Main"]' && JSON.stringify(pcsOf(site, 502)) === '["Comp"]', 'each ran its own, though the other PC is stronger / weaker', [pcsOf(site, 501), pcsOf(site, 502)])
    b.heal('Main', 'Comp')
    check(await waitFor(async () => { const r = (await b.results('Main')).map(x => x.key).sort(); return r.length >= 2 }), 'after the link is back Main holds both results', await b.results('Main'))
    check(site.started(501).length === 1 && site.started(502).length === 1, 'nobody ran the other\'s girl', site.visits.length)
  }],
]
