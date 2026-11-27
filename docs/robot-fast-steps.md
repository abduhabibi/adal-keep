# Faster robot steps (2026-11-27) — `ADAL_FAST_STEPS=0` brings every old wait back

## What this is based on (read this first)
No robot step-time log was on this PC (`data/robots.log` is empty here; Main's was not yet copied). So the ranking at the end is read from the
SOURCE by `node scripts/step-cost.mjs`: the longest time a step can spend in a fixed sleep, a quiet-network wait or a page load. It is what a
step costs at most, not what Main measured. When Main's robots.log comes, the same ranking can be made from real times.

## Changed (each behind the switch; no click, Save, Submit or check was touched)
| site | step (file) | before | after |
|---|---|---|---|
| Musaned | after Musaned's sign-in page loads / the Login click (`stepOpenMusaned`, 3 places) | fixed 1.5 s each | ends when Keycloak or Musaned's picker / dashboard shows |
| Musaned | after Go to Dashboard (`stepClickGoToDashboard`) | fixed 2.5 s (2 s by direct address) | ends when the HR Pool link shows (mock: 2512 ms -> 314 ms) |
| Musaned | after the HR Pool page opens (`stepClickHrPool`) | fixed 1 s + polls of 0.4 / 0.5 s | ends when Add New Candidate shows; polls 150 ms (mock 1022 -> 324 ms) |
| Musaned | after Add New Candidate (`stepClickAddNewCandidate`) | fixed 1.5 s | ends when the ID Number box shows, which the next step needs (mock 1503 -> 308 ms) |
| Musaned | "is she in our HR Pool list" (`findInOurList`) | page load waits for a quiet network (up to 25 s on the real site), +0.7 s, then quiet network +1.2 s | page ready when its filter shows; her row showing ends the wait (mock site that never goes quiet: found 31.7 s -> 0.7 s; not found 31.6 s -> 21.5 s, its answer still waits for the quiet network) |
| Musaned | contracts check: list search (`search`) and the contract pages (the add path of `scanContracts`, `requestDetails`) in musanedContracts.js | page load waits for a quiet network (up to 25 s each) + 1.5 s + 0.7 s | ready when the filter / the contract's own number / Musaned's sign-in shows |
| Enjaz | after pressing Login with the captcha (`mofaVisa.js` signIn) | fixed 5 s | ends when the login form is gone |
| Enjaz | the occupations list after Classify (2 places) | 24 polls of 0.5 s | polls of 0.17 s, same 12 s longest |
| Tasheer | Upload Sheet button found / enabled, Save enabled (all BEFORE Save) | polls of 1 s | polls of 0.33 s, same longest wait; the 1.5 s after the grid is filled ends when all rows are in |
| LMIS | waiting for the police page | poll 1 s | poll 0.33 s |
| Insurance | waiting for a person to sign in (FetaP) | poll 2 s | poll 0.4 s |

Mock proof (a headless Chrome of its own, no real site): `tests/fastSteps.test.js` — before = switch off, after = on; the times are printed.
Mock-tested end to end: Musaned dashboard -> HR Pool -> Add New Candidate, and the HR Pool lookup. Helper-level only (their code sits inside long
flows that need the real sites): Enjaz, Tasheer, LMIS, Insurance and the contracts check.

## Not changed, and why
- Wafid `sleep(20000)` after "I am not a robot": it is the back-off before trying again, not a wait for the page (captcha rule). Its 2 s polls
  and the 2.5 s after a person answers are human waits.
- Everything after Save / Submit (Tasheer's Save answer polls, the confirmation clicks).
- LMIS `stepVerifyForm` asks JEV to look at each form section one after another (about 2.5 s each): that is a check; running the sections in
  parallel is possible but needs a live LMIS to prove: not done.
- The contracts check's list page (`scanContracts`, networkidle2): its readers need that page quiet.
- Parallel tabs: one run at a time on a weak Main is the rule.
- "Not found" in the HR Pool lookup stays as slow as before: nothing on the page says "no result" that I can rely on, so it still waits for the
  quiet network (shortening it could call a girl "not in our list" when Musaned was only slow).

## The ranking (`node scripts/step-cost.mjs`, longest possible waits, from the code)
    
    ## Musaned — 83 fixed sleeps in the code, 68 s if every one ran once
     90000 ms  page load          musanedContracts.js:1111  apiHeadersOf  await page.goto('https://tawtheeq.musaned.com.sa/employment-requests?sort=createdAt,DESC&page=0&size=10',
     60000 ms  page load          musanedContracts.js:309  scanContracts  if (backTo && page && !page.isClosed?.()) await page.goto(backTo, { waitUntil: 'domcontentloaded', timeou
     60000 ms  page load          musanedContracts.js:1191  openContract  await page.goto(`https://tawtheeq.musaned.com.sa/employment-requests/contract/${card.id}`, { waitUntil: '
     60000 ms  page load          musanedImport.js:60  searchPassport  await page.goto(HR_POOL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
     60000 ms  page load          musanedImport.js:212  openHerPage  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
     25000 ms  quiet-network wait musanedWorkflow.js:869  findInOurList  await page.goto('https://tawtheeq.musaned.com.sa/hr-pool', { waitUntil: fastOn() ? 'domcontentloaded' : 'n
     25000 ms  quiet-network wait musanedContracts.js:95  search  await page.goto(url, { waitUntil: fastOn() ? 'domcontentloaded' : 'networkidle2', timeout: 60000 })
     25000 ms  quiet-network wait musanedContracts.js:218  scanContracts  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
     25000 ms  quiet-network wait musanedContracts.js:284  scanContracts  await page.goto(c.url, { waitUntil: fastOn() ? 'domcontentloaded' : 'networkidle2', timeout: 60000 })
     25000 ms  quiet-network wait musanedContracts.js:700  requestDetails  await page.goto(c.url, { waitUntil: fastOn() ? 'domcontentloaded' : 'networkidle2', timeout: 60000 })
    
    ## Enjaz — 5 fixed sleeps in the code, 6 s if every one ran once
    120000 ms  page load          mofaVisa.js:512  signIn  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 })
    120000 ms  page load          mofaVisa.js:583  openForm  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
    120000 ms  page load          mofaVisa.js:965  runMofaPay  if (!(await clickText(page, /^\s*Pay\s+Visa\s+Fees\s*$/))) await page.goto(PAY_URL, { waitUntil: 'domcontentlo
    120000 ms  page load          mofaVisa.js:967  runMofaPay  if (onLogin(page)) { await signIn(page, ctx); await page.goto(PAY_URL, { waitUntil: 'domcontentloaded', timeou
    120000 ms  page load          mofaVisa.js:1031  runMofaFindApp  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
    120000 ms  page load          mofaVisa.js:1032  runMofaFindApp  if (onLogin(page)) { await signIn(page, ctx); await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeo
      3000 ms  fixed sleep        mofaVisa.js:852  waitForSave  await sleep(3000)
      2000 ms  fixed sleep        mofaVisa.js:571  signIn  await sleep(2000)
       500 ms  fixed sleep        mofaVisa.js:55  until  await sleep(500)
       400 ms  fixed sleep        mofaVisa.js:289  typeInSelect  await sleep(400)
    
    ## Wafid — 4 fixed sleeps in the code, 25 s if every one ran once
     20000 ms  fixed sleep        wafidWorkflow.js:505  runWafidSlip  await sleep(20000)
      2500 ms  fixed sleep        wafidWorkflow.js:424  runWafidCheck  await sleep(2500)
      2000 ms  fixed sleep        wafidWorkflow.js:423  runWafidCheck  while (Date.now() < end && await challengeShown(page)) await sleep(2000)
       500 ms  fixed sleep        wafidWorkflow.js:373  downloadResultPdf  await sleep(500)
    
    ## Tasheer — 10 fixed sleeps in the code, 8 s if every one ran once
    120000 ms  page load          tasheer.js:444  signIn  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => log(ctx, `navigation thr
    120000 ms  page load          tasheer.js:450  signIn  if (await notAllowed(page)) await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((
      2000 ms  fixed sleep        tasheer.js:1050  uploadAndSave  await sleep(2000)
      1500 ms  fixed sleep        tasheer.js:1039  uploadAndSave  if (await clickText(f, /^\s*(yes|ok|okay|confirm|proceed|continue|submit|yes,?\s*(save|confirm))\s*$/).catch((
      1000 ms  fixed sleep        tasheer.js:970  uploadAndSave  await sleep(1000)
      1000 ms  fixed sleep        tasheer.js:1034  uploadAndSave  await sleep(1000)
       600 ms  fixed sleep        tasheer.js:381  afterConcurrentLogin  await sleep(600)
       500 ms  fixed sleep        tasheer.js:372  afterConcurrentLogin  for (const end = Date.now() + graceMs; Date.now() < end && await concurrentShown(page);) { check(); await s
       500 ms  fixed sleep        tasheer.js:379  afterConcurrentLogin  for (const end = Date.now() + 30000; Date.now() < end && !(ok = await back());) { check(); await sleep(500)
       400 ms  fixed sleep        tasheer.js:406  afterConcurrentLogin  await sleep(400)
    
    ## LMIS — 25 fixed sleeps in the code, 13 s if every one ran once
    240000 ms  page load          lmisWorkflow.js:434  stepLoginNow  try { await page.goto(shared, { waitUntil: 'domcontentloaded', timeout: 240000 }) } catch (e) { log(ctx, `navi
    240000 ms  page load          lmisWorkflow.js:457  stepLoginNow  await page.goto(`${LMIS_BASE}/auth`, { waitUntil: 'domcontentloaded', timeout: 240000 })
    240000 ms  page load          lmisWorkflow.js:484  stepLoginNow  await page.goto(`${LMIS_BASE}/auth`, { waitUntil: 'domcontentloaded', timeout: 240000 })
      2500 ms  JEV call           lmisWorkflow.js:53    import { lookAtPage, lookUnavailableReason } from './jevClassifier.js'
      2500 ms  JEV call           lmisWorkflow.js:1962  stepVerifyForm  if (!seen && !ctx.__jevWhy) {
      2500 ms  JEV call           lmisWorkflow.js:1963  stepVerifyForm  ctx.__jevWhy = lookUnavailableReason() || 'JEV did not answer'
      2500 ms  JEV call           lmisWorkflow.js:1964  stepVerifyForm  log(ctx, `JEV could not look at the form (${ctx.__jevWhy}) — checking it by reading the page only`, 'warn
      2500 ms  JEV call           lmisWorkflow.js:1975  stepVerifyForm  const jev = seen ? seen[sec.key] : null
      2500 ms  JEV call           lmisWorkflow.js:1977  stepVerifyForm  (dom === 'missing' && !(jev !== null && jev >= 0.9)) || // page says missing (JEV can overrule only when su
      2500 ms  JEV call           lmisWorkflow.js:1978  stepVerifyForm  (dom === 'done' && jev !== null && jev <= 0.1) ||       // JEV sure it is not done
    
    ## Insurance — 3 fixed sleeps in the code, 2 s if every one ran once
    120000 ms  page load          insuranceCertificate.js:117  signIn  await page.goto(DRAFT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => log(ctx, `navigati
    120000 ms  page load          insuranceCertificate.js:300  runInsuranceCertificate  if (!/\/certificate\/draft/i.test(page.url())) await page.goto(DRAFT_URL, { waitUntil: 'dom
    120000 ms  page load          insuranceCertificate.js:410  runGroupCertificate  if (!/\/certificate\/draft/i.test(page.url())) await page.goto(DRAFT_URL, { waitUntil: 'domcont
    120000 ms  page load          insuranceFetch.js:103  openApproved  await page.goto(APPROVED_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => log(ctx, `navig
      1500 ms  quiet-network wait insuranceFetch.js:131  captureCertificate  await tab.waitForNetworkIdle({ idleTime: 1500, timeout: 45000 }).catch(() => {})
       800 ms  fixed sleep        insuranceFetch.js:193  runInsuranceFetch  await sleep(800)
       500 ms  fixed sleep        insuranceCertificate.js:42  until  await sleep(500)
       500 ms  fixed sleep        insuranceFetch.js:40  until  await sleep(500)
