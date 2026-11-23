/**
 * Button sweep (asked on 2026-11-23): every visible button and link on each page is
 * clicked, one at a time, each on a fresh tab, and reported when it throws, shows the
 * "This page could not be shown" box, gets a 5xx, or changes nothing at all.
 * Run it against a scratch copy (ADAL_ISOLATED=1, its own SQLITE_PATH), never an agency's data.
 *
 *   SWEEP_BASE=http://127.0.0.1:4377 node scripts/button-sweep.mjs <desktop|phone> /,/profiles,/settings out.json
 *
 * Unsafe-here buttons (update, quit, restore, …) are skipped. "NOTHING" also flags tabs
 * already open and lists that only reorder: look at those by hand. Each run stops at 9 min.
 */
import fs from 'fs'
const puppeteer = (await import('puppeteer')).default
const [mode, pagesArg, out] = process.argv.slice(2)
const BASE = process.env.SWEEP_BASE || 'http://127.0.0.1:4377'
const PHONE = mode === 'phone'
const FIND = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && !e.disabled }
  const lab = (e) => (e.innerText || e.getAttribute('aria-label') || e.title || e.getAttribute('href') || e.type || '').trim().replace(/\\s+/g, ' ').slice(0, 60)
  return [...document.querySelectorAll('button, [role="button"], a[href], input[type="checkbox"], summary')].map(e => ({ e, label: lab(e), side: !!e.closest('aside, [data-sidebar], .ak-sidebar'), ext: e.tagName === 'A' && /^https?:/.test(e.getAttribute('href') || '') && !e.href.startsWith(location.origin) })).filter(x => vis(x.e) && !x.ext)
})()`
const SKIP = /update|install|previous version|roll ?back|restart|quit|shut ?down|log ?out|sign ?out|uninstall|reset|wipe|leave (the )?agency|restore (backup|from|the database)|backup now|apply|unlock|access code|delete all|empty trash/i
const deadline = Date.now() + 9 * 60000   // a run never goes past 10 minutes

const browser = await puppeteer.launch({ ...(process.env.SWEEP_CHROME || fs.existsSync('/usr/bin/google-chrome') ? { executablePath: process.env.SWEEP_CHROME || '/usr/bin/google-chrome' } : {}), headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
let page = null
let opening = false
let ev = null
const reset = () => { ev = { pageErrors: [], consoleErrors: [], api: [], requests: 0, dialogs: [], popups: 0, chooser: false } }
reset()
async function fresh() {
  const old = page
  opening = true
  page = await browser.newPage()
  opening = false
  if (old) await old.close().catch(() => {})
  if (PHONE) { await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/120 Mobile AdalKeepPhone'); await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }) }
  else await page.setViewport({ width: 1366, height: 800 })
  // The once-a-day tour walks a person to its lesson's page: off here (each test browser is new).
  await page.evaluateOnNewDocument(() => { const g = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^adal-tour-/.test(k) ? '1' : g.call(this, k) } })

  page.on('pageerror', e => ev.pageErrors.push(String(e.message).slice(0, 300)))
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_ABORTED|Failed to load resource/.test(m.text())) ev.consoleErrors.push(m.text().slice(0, 300)) })
  page.on('request', r => { if (r.url().startsWith(BASE + '/api') && r.method() !== 'GET') ev.requests++; else if (r.url().startsWith(BASE + '/api')) ev.requests += 0.01 })
  page.on('response', r => { const u = r.url(); if (u.startsWith(BASE + '/api') && r.status() >= 400) ev.api.push(`${r.request().method()} ${u.slice(BASE.length)} ${r.status()}`) })
  page.on('dialog', d => { if (d.type() === 'beforeunload') return d.accept().catch(() => {}); ev.dialogs.push(d.message().slice(0, 120)); d.dismiss().catch(() => {}) })
}
browser.on('targetcreated', async t => { if (t.type() === 'page' && !opening) { ev.popups++; try { const p = await t.page(); await p?.close() } catch {} } })

const wait = (ms) => new Promise(r => setTimeout(r, ms))
async function open(url) {
  reset()
  await fresh()
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 15000 })
    await wait(1200)
    // In the app, as a person goes there (a fresh window starts at the Dashboard).
    if (url !== '/') await page.evaluate((u) => { history.pushState({ idx: 1 }, '', u); window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 1 } })) }, url)
  }
  catch (e) { process.stderr.write(`  (load of ${url} slow: ${e.message.slice(0, 60)})\n`); try { await page.goto('about:blank', { timeout: 5000 }); await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 15000 }) } catch {} }
  await wait(2200)
}
// Every visible clickable thing (not the sidebar, except on '/'), in document order.
const collect = async (withSide) => {
  // Wait until the page stops growing (lazy pages, their data).
  let n = -1
  for (let k = 0; k < 8; k++) { const m = await page.evaluate(`${FIND}.length`); if (m === n) break; n = m; await wait(500) }
  return page.evaluate(`${FIND}.filter(x => ${withSide} || !x.side).map((x, i) => ({ tag: x.e.tagName, label: x.label }))`)
}
const snap = () => page.evaluate(() => !document.body ? { url: location.pathname, html: 'none', boundary: false } : ({ url: location.pathname + location.search + location.hash, html: document.body.innerHTML.length + ':' + document.body.innerText.length + ':' + document.querySelectorAll('*').length, boundary: /This page could not be shown/.test(document.body.innerText) }))

const results = []
for (const url of pagesArg.split(',')) {
  if (Date.now() > deadline) { results.push({ page: url, skipped: 'time' }); continue }
  await open(url)
  const s0 = await snap()
  if (s0.url.split('?')[0] !== url.split('?')[0]) results.push({ page: url, label: '(page load)', verdict: 'NOT FOUND', clickErr: 'landed on ' + s0.url })
  if (s0.boundary || ev.pageErrors.length) results.push({ page: url, label: '(page load)', verdict: 'ERROR', pageErrors: ev.pageErrors, boundary: s0.boundary })
  const list = await collect(url === '/')
  const seen = new Map()
  for (const it of list) {
    if (Date.now() > deadline) { results.push({ page: url, skipped: 'time', left: list.length }); break }
    const key = it.label + '|' + it.tag
    const n = (seen.get(key) || 0) + 1; seen.set(key, n)
    if (n > 2) continue                       // repeated rows (each profile card): the first three
    if (SKIP.test(it.label)) { results.push({ page: url, label: it.label, verdict: 'skipped (unsafe here)' }); continue }
    process.stderr.write(`${url} ${it.label}\n`)
    await open(url)
    const before = await snap()
    reset()
    const fc = page.waitForFileChooser({ timeout: 1500 }).then(c => { ev.chooser = true; return c.cancel() }).catch(() => {})
    let clickErr = null
    try {
      await collect(url === '/')
      const ok = await page.evaluate(`(() => { const all = ${FIND}.filter(x => ${url === '/'} || !x.side).filter(x => x.label === ${JSON.stringify(it.label)} && x.e.tagName === ${JSON.stringify(it.tag)}); const x = all[${n - 1}]; if (!x) return false; x.e.scrollIntoView({ block: 'center' }); x.e.click(); return true })()`)
      if (!ok) clickErr = 'gone after reload'
    } catch (e) { clickErr = e.message.slice(0, 120) }
    await wait(1500); await fc
    let after
    try { after = await snap() } catch { after = { url: '?', html: '?', boundary: false } }
    const changed = after.url !== before.url || after.html !== before.html || Math.floor(ev.requests) > 0 || ev.dialogs.length || ev.popups || ev.chooser
    const server5 = ev.api.filter(a => / 5\d\d$/.test(a) && !/chat\/|\/cloud|online/.test(a))   // (no online account in the test copy)
    const verdict = ev.pageErrors.length || after.boundary || server5.length ? 'ERROR' : clickErr ? 'NOT FOUND' : !changed ? 'NOTHING' : 'ok'
    results.push({ page: url, label: it.label, tag: it.tag, verdict, ...(verdict !== 'ok' || ev.api.length ? { pageErrors: ev.pageErrors, api: ev.api, console: ev.consoleErrors.slice(0, 3), dialogs: ev.dialogs, clickErr } : {}) })
  }
}
fs.writeFileSync(out, JSON.stringify(results, null, 1))
const bad = results.filter(r => r.verdict && !/^(ok|skipped)/.test(r.verdict))
console.log(`${mode}: ${results.filter(r => r.verdict === 'ok').length} ok, ${bad.length} to look at, ${results.filter(r => /^skipped/.test(r.verdict || r.skipped || '')).length} skipped`)
for (const r of bad) console.log(` ${r.verdict} ${r.page} «${r.label}» ${[...(r.pageErrors || []), ...(r.api || [])].join(' | ')}`)
await browser.close()
