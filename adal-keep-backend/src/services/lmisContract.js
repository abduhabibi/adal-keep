/**
 * lmisContract.js — "Create LMIS contract" (workflow id: lmis_contract).
 *
 * When an employer chose her on Musaned (profiles.chosen_at) and Wafid says
 * FIT (profiles.status = 'medical_fit'), the scanner queues this run:
 *
 *   1. LMIS sign-in (the shared one — no new SMS code when LMIS is signed in
 *      in another tab)
 *   2. lmis.gov.et/organization/register/ (Contract)
 *   3. search her Labor ID
 *   4. Open her row (only the row with exactly that Labor ID)
 *   5. on her page (Labor ID checked again): Create Contract
 *
 * Then the tab is handed to a person, who continues the contract there.
 * A labor that already has an employment contract is left as it is.
 */
import { log, settle, closePopups, stepLogin } from './lmisWorkflow.js'

export const LMIS_CONTRACT = 'lmis_contract'
const REGISTER_URL = 'https://lmis.gov.et/organization/register/'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const cancelled = (ctx) => typeof ctx.isCancelled === 'function' && ctx.isCancelled()

/** Waits until `test()` is true (checked every 500 ms). */
async function until(test, ms, ctx) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
    if (await test().catch(() => false)) return true
    await sleep(500)
  }
  return false
}

const text = (page) => page.evaluate(() => document.body?.innerText || '').catch(() => '')

async function openContracts(page, ctx) {
  log(ctx, 'opening LMIS → Contract (organization/register)')
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded', timeout: 240000 })
      .catch(e => log(ctx, `navigation threw: ${e.message}`, 'warn'))
    const ok = await until(async () => {
      if (/\/(auth|login)/i.test(page.url())) return true
      return /Labor ID/i.test(await text(page)) && !!(await page.$('input'))
    }, 90000, ctx)
    if (/\/(auth|login)/i.test(page.url())) {
      log(ctx, 'LMIS asked to sign in again', 'warn')
      await stepLogin(page, ctx)
      continue
    }
    if (ok) { await settle(page); await closePopups(page, ctx); log(ctx, '✓ Contract page open'); return }
    log(ctx, 'the Contract page did not finish loading — loading it again', 'warn')
  }
  throw new Error('The LMIS Contract page did not open')
}

/** Types the Labor ID in the page's search box. */
async function search(page, ctx, laborId) {
  const box = await page.evaluateHandle(() => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 10 }
    const inputs = [...document.querySelectorAll('input')].filter(i => seen(i) && !i.disabled && /^(text|search|)$/i.test(i.type))
    // The search box: next to the red "clear" button, or one that says search.
    const byClear = inputs.find(i => [...(i.closest('div')?.parentElement?.querySelectorAll('button') || [])].some(b => /clear/i.test(b.innerText || '')))
    const byHint = inputs.find(i => /search|labor|id/i.test(`${i.placeholder} ${i.name} ${i.id} ${i.getAttribute('aria-label') || ''}`))
    return byClear || byHint || inputs[0] || null
  })
  const el = box.asElement()
  if (!el) throw new Error('The search box was not found on the LMIS Contract page')
  await el.click({ clickCount: 3 })
  await page.keyboard.press('Backspace')
  await el.type(laborId, { delay: 40 })
  await el.press('Enter').catch(() => {})
  log(ctx, `searching Labor ID ${laborId}`)
}

/** The table row with exactly this Labor ID: { found, count } */
function rowState(page, laborId) {
  return page.evaluate((id) => {
    const want = id.toUpperCase()
    const rows = [...document.querySelectorAll('tr, [role="row"]')].filter(r => r.getBoundingClientRect().height > 0)
    const mine = rows.filter(r => r.innerText.toUpperCase().split(/\s+/).includes(want))
    return { found: mine.length, rows: rows.length, none: /no (record|data|result)/i.test(document.body.innerText || '') }
  }, laborId).catch(() => ({ found: 0, rows: 0, none: false }))
}

/** Presses Open in her row; the page opens in this same tab. */
async function openRow(page, ctx, laborId) {
  const target = await page.evaluate((id) => {
    const want = id.toUpperCase()
    const row = [...document.querySelectorAll('tr, [role="row"]')]
      .find(r => r.getBoundingClientRect().height > 0 && r.innerText.toUpperCase().split(/\s+/).includes(want))
    const btn = row && [...row.querySelectorAll('a, button, [role="button"]')].find(b => /^\s*open\s*$/i.test(b.innerText || ''))
    if (!btn) return null
    btn.setAttribute('data-adal-open', '1')
    return { href: btn.tagName === 'A' ? btn.href : '' }
  }, laborId)
  if (!target) throw new Error(`No "Open" button in the row of ${laborId}`)
  if (target.href) { await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 240000 }); return }

  // A button: it may open her page in this tab or in a new one.
  const browser = page.browser()
  const popup = new Promise(resolve => {
    const on = (t) => { if (t.opener() === page.target()) { browser.off('targetcreated', on); resolve(t) } }
    browser.on('targetcreated', on)
    setTimeout(() => { browser.off('targetcreated', on); resolve(null) }, 8000)
  })
  const before = page.url()
  await page.click('[data-adal-open="1"]')
  const t = await popup
  if (t) {
    // Opened in a new tab: her page is loaded in this run's own tab instead.
    const p2 = await t.page().catch(() => null)
    await until(async () => p2 && p2.url() && p2.url() !== 'about:blank', 15000, ctx)
    const url = p2?.url()
    await p2?.close().catch(() => {})
    if (url && url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 })
  } else if (page.url() === before) {
    await sleep(1000)
  }
}

export async function runLmisContract(page, ctx) {
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const p = ctx.profile || {}
  const laborId = String(p.labor_id || '').trim().toUpperCase()
  if (!laborId) return { ok: false, step: 'preflight', error: 'The profile has no Labor ID', seconds: 0 }

  await stepLogin(page, ctx)
  await openContracts(page, ctx)

  // 3. Search: only her row (exactly her Labor ID) is accepted.
  let found = false
  for (let attempt = 1; attempt <= 3 && !found; attempt++) {
    await search(page, ctx, laborId)
    found = await until(async () => (await rowState(page, laborId)).found > 0, 45000, ctx)
    if (!found) {
      const st = await rowState(page, laborId)
      if (st.none && attempt >= 2) break
      log(ctx, `Labor ID ${laborId} not listed yet — searching again (${attempt}/3)`, 'warn')
    }
  }
  if (!found) {
    const error = `Labor ID ${laborId} is not in the LMIS Contract list`
    log(ctx, error, 'error')
    await ctx.notify(`❌ ${ctx.profileName}: LMIS contract not started`, `${error}. Check the Labor ID on the profile and in LMIS.`)
    return { ok: false, step: 'search', error, seconds: secs() }
  }
  log(ctx, `✓ found ${laborId} — pressing Open`)

  // 4. Her page.
  await openRow(page, ctx, laborId)
  const onHerPage = await until(async () => {
    const t = (await text(page)).toUpperCase()
    return t.includes('PROCESS TIMELINE') && t.includes(laborId)
  }, 90000, ctx)
  if (!onHerPage) {
    const t = await text(page)
    const error = /PROCESS TIMELINE/i.test(t)
      ? `The page that opened is not ${laborId} — stopped without creating anything`
      : 'Her LMIS page did not open'
    log(ctx, error, 'error')
    return { ok: false, step: 'open', error, seconds: secs() }
  }
  await settle(page)
  await closePopups(page, ctx)
  log(ctx, `✓ ${ctx.profileName}'s LMIS page is open (${laborId})`)

  // 5. Create Contract — only when she has none yet.
  const hasButton = await until(async () => page.evaluate(() =>
    [...document.querySelectorAll('button, a')].some(b => /create contract/i.test(b.innerText || '') && b.getBoundingClientRect().width > 0)
  ), 20000, ctx)
  if (!hasButton) {
    log(ctx, 'there is no "Create Contract" button — she already has an employment contract on LMIS; nothing was changed')
    await ctx.notify(`ℹ️ ${ctx.profileName}: LMIS contract already started`, `Her LMIS page (${laborId}) shows no "Create Contract" button — the contract exists already.`)
    return { ok: true, note: 'contract already exists', seconds: secs() }
  }
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, a')].find(x => /create contract/i.test(x.innerText || '') && x.getBoundingClientRect().width > 0)
    b?.scrollIntoView({ block: 'center' }); b?.click()
  })
  log(ctx, '✓ pressed Create Contract')
  await sleep(2500)
  await settle(page)

  await ctx.notify(`🔔 ${ctx.profileName}: LMIS contract started`,
    `Create Contract was pressed on her LMIS page (${laborId}). Continue the contract in the LMIS tab.`)
  log(ctx, '✅ done — the contract continues by hand in this tab')
  return { ok: true, note: 'Create Contract pressed — continue by hand', seconds: secs() }
}
