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
 *   6. the contract window: Experienced / Non Experienced (profile), the job
 *      order of her Musaned recruitment office (PRO), Beginning of Contract
 *      = today, Ending = 2 years later, and from her Musaned contract:
 *      passport and visa numbers, employer city / full name / phone, house
 *      number (the first number of the employer's address)
 *
 * The window's own Create Contract is pressed by a person (Adal Keep never
 * presses it).
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
  log(ctx, '✓ pressed Create Contract — the contract window opens')

  // 6. The contract window.
  const form = await until(async () => /Select A Job Order/i.test(await text(page)), 30000, ctx)
  if (!form) {
    await ctx.notify(`🖐 ${ctx.profileName}: LMIS contract window did not open`, `Create Contract was pressed on her LMIS page (${laborId}); continue in the LMIS tab.`)
    return { ok: true, note: 'Create Contract pressed — the window did not show', seconds: secs() }
  }
  const left = await fillContractWindow(page, ctx, p)

  await ctx.notify(`🔔 ${ctx.profileName}: LMIS contract ready to create`,
    left.length
      ? `Filled on her LMIS contract window (${laborId}). Please fill by hand: ${left.join(', ')}. Then check and press Create Contract.`
      : `Everything is filled on her LMIS contract window (${laborId}). Check it and press Create Contract.`)
  log(ctx, `✅ done — WAITING for a person to press Create Contract${left.length ? ` (left for the person: ${left.join(', ')})` : ''}`)
  return { ok: true, note: 'contract window filled — awaiting the person', seconds: secs() }
}

// --------------------------------------------------------------------------
// The contract window: experience, job order, beginning date, passport, visa
// --------------------------------------------------------------------------
const experienced = (p) => /have|yes/i.test(String(p.work_experience || '')) || Number(p.experience_years) > 0

// Words that say nothing about which office it is.
const COMMON = new Set(['recruitment', 'office', 'offices', 'company', 'co', 'est', 'establishment', 'for', 'the', 'and', 'of', 'manpower', 'services', 'agency', 'llc', 'ltd'])
const words = (s) => String(s || '').toLowerCase().replace(/^job\d+\s*-\s*/i, '').replace(/^al[-\s]/, 'al').split(/[^a-z0-9؀-ۿ]+/).filter(w => w.length > 1 && !COMMON.has(w))

/** The job order whose office is her Musaned recruitment office (PRO), or null. */
export function pickJobOrder(options, pro) {
  const want = new Set(words(pro))
  if (!want.size) return null
  const scored = options.map(o => {
    const have = words(o)
    const shared = have.filter(w => want.has(w)).length
    return { o, shared, score: shared / Math.max(1, Math.min(want.size, have.length)) }
  }).filter(x => x.shared >= 2 || (x.shared === 1 && x.score === 1)).sort((a, b) => b.score - a.score || b.shared - a.shared)
  if (!scored.length) return null
  if (scored[1] && scored[1].score === scored[0].score && scored[1].shared === scored[0].shared) return null // two equally good: a person chooses
  return scored[0].o
}

async function clickText(page, re) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i')
    const b = [...document.querySelectorAll('button, [role="tab"], [role="button"], label, span, div')]
      .filter(e => re.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0)
      .sort((a, b) => a.innerText.length - b.innerText.length)[0]
    if (!b) return false
    b.click(); return true
  }, re.source)
}

/** Sets an input's value the way React notices it. */
async function setInput(page, selector, value) {
  return page.evaluate((sel, v) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null
    if (!el) return false
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new Event('blur', { bubbles: true }))
    return el.value === v
  }, selector, value)
}

/** Marks the input under a label ("Beginning of Contract", "Visa Number"…). */
function markByLabel(page, label, mark) {
  return page.evaluate((label, mark) => {
    const lab = [...document.querySelectorAll('label, p, span, div')]
      .find(e => e.children.length === 0 && new RegExp(`^\\s*${label}\\s*$`, 'i').test(e.textContent || ''))
    let box = lab?.parentElement, input = null
    for (let i = 0; i < 3 && box && !input; i++, box = box.parentElement) input = box.querySelector('input')
    if (!input) return false
    input.setAttribute('data-adal', mark)
    return true
  }, label, mark)
}

const hasLabel = (page, label) => page.evaluate((label) =>
  [...document.querySelectorAll('label, p, span, div')].some(e => e.children.length === 0 && new RegExp(`^\\s*${label}\\s*$`, 'i').test(e.textContent || '')), label)

// Saudi cities: the names LMIS may list, and how the contract may write them.
const CITIES = [
  ['Riyadh', /riyad|الرياض/i], ['Jeddah', /jedd?ah|jidd?ah|jidda|جدة|جده/i], ['Makkah', /makk?ah|mecca|مكة/i],
  ['Madinah', /madinah|medina|المدينة/i], ['Dammam', /dammam|الدمام/i], ['Khobar', /khobar|الخبر/i],
  ['Taif', /ta'?if|الطائف/i], ['Abha', /abha|أبها|ابها/i], ['Khamis Mushait', /khamis|خميس/i],
  ['Buraydah', /buraid|buraydah|بريدة/i], ['Hail', /\bh[aā]'?il\b|حائل/i], ['Tabuk', /tabuk|تبوك/i],
  ['Jazan', /jazan|jizan|جازان|جيزان/i], ['Najran', /najran|نجران/i], ['Al Ahsa', /ahsa|hofuf|الأحساء|الاحساء|الهفوف/i],
  ['Qatif', /qatif|القطيف/i], ['Yanbu', /yanbu|ينبع/i], ['Al Kharj', /kharj|الخرج/i], ['Jubail', /jubail|الجبيل/i],
  ['Al Qassim', /qass?im|القصيم/i], ['Unaizah', /unaizah|onaizah|عنيزة/i], ['Al Baha', /baha|الباحة/i],
  ['Arar', /\barar\b|عرعر/i], ['Sakaka', /sakaka|سكاكا/i], ['Hafar Al Batin', /hafar|حفر الباطن/i],
]
const cityPattern = (name) => (CITIES.find(([n, re]) => re.test(name) || n.toLowerCase() === String(name).toLowerCase()) || [null, null])[1]
const citiesIn = (text) => CITIES.filter(([, re]) => re.test(text)).map(([n]) => n)

/** Opens the Employer city list, types the city and picks the matching entry. */
async function pickCity(page, ctx, wanted) {
  const control = await page.evaluateHandle(() => {
    const lab = [...document.querySelectorAll('label, p, span, div')].find(e => e.children.length === 0 && /^\s*Employer city\s*$/i.test(e.textContent || ''))
    let box = lab?.parentElement
    for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
      const c = box.querySelector('select, [class*="control"], [role="combobox"], input')
      if (c) return c
    }
    return null
  })
  const el = control.asElement()
  if (!el) return null
  for (const name of wanted) {
    const re = cityPattern(name)
    const tag = await el.evaluate(e => e.tagName)
    if (tag === 'SELECT') {
      const v = await el.evaluate((e, src, name) => {
        const r = src ? new RegExp(src, 'i') : null
        const o = [...e.options].find(o => (r ? r.test(o.text) : o.text.trim().toLowerCase() === name.toLowerCase()))
        if (!o) return null
        e.value = o.value; e.dispatchEvent(new Event('change', { bubbles: true })); return o.text.trim()
      }, re?.source || null, name)
      if (v) return v
      continue
    }
    await el.click().catch(() => {})
    await sleep(500)
    // react-select: typing narrows the list.
    const typed = (CITIES.find(([n, r]) => r.test(name)) || [name])[0]
    await page.keyboard.type(typed.split(' ')[0].slice(0, 5), { delay: 60 })
    await sleep(1200)
    const got = await page.evaluate((src, name) => {
      const r = src ? new RegExp(src, 'i') : null
      const o = [...document.querySelectorAll('[role="option"], [class*="option"]')]
        .filter(x => x.getBoundingClientRect().height > 0)
        .find(x => (r ? r.test(x.innerText || '') : (x.innerText || '').trim().toLowerCase() === name.toLowerCase()))
      if (!o) return null
      o.scrollIntoView({ block: 'center' }); o.click(); return (o.innerText || '').trim()
    }, re?.source || null, name)
    if (got) return got
    // Not this one: clear what was typed and try the next name.
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace')
    await page.keyboard.press('Escape').catch(() => {})
  }
  log(ctx, `no Employer city entry matches ${wanted.join(' / ') || '(no city on the contract)'} — left for the person`, 'warn')
  return null
}

async function fillContractWindow(page, ctx, p) {
  const left = []

  // Experienced / Non Experienced, from the profile.
  const exp = experienced(p)
  if (await clickText(page, exp ? /^Experienced$/ : /^Non Experienced$/)) log(ctx, `✓ ${exp ? 'Experienced' : 'Non Experienced'} (profile: ${p.work_experience || 'no experience'})`)
  else left.push('Experienced / Non Experienced')
  await sleep(600)

  // Job order: the one of her Musaned recruitment office.
  const pro = String(p.musaned_pro || '').trim()
  const control = await page.evaluateHandle(() => {
    const lab = [...document.querySelectorAll('label, p, span, div')].find(e => e.children.length === 0 && /^\s*Select A Job Order\s*$/i.test(e.textContent || ''))
    let box = lab?.parentElement
    for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
      const c = box.querySelector('[class*="control"], [role="combobox"], input, select')
      if (c) return c
    }
    return null
  })
  let chosen = null
  if (control.asElement()) {
    await control.asElement().click().catch(() => {})
    await sleep(1200)
    const options = await page.evaluate(() => {
      const sel = document.querySelector('select')
      if (sel && sel.options.length > 1) return [...sel.options].map(o => o.text.trim()).filter(Boolean)
      return [...document.querySelectorAll('[role="option"], [class*="option"]')].map(o => (o.innerText || '').trim()).filter(t => /^JOB/i.test(t))
    })
    log(ctx, `job orders: ${options.length ? options.join(' | ') : 'none listed'}`)
    chosen = pickJobOrder(options, pro)
    if (chosen) {
      await page.evaluate((want) => {
        const sel = document.querySelector('select')
        if (sel && [...sel.options].some(o => o.text.trim() === want)) {
          sel.value = [...sel.options].find(o => o.text.trim() === want).value
          sel.dispatchEvent(new Event('change', { bubbles: true })); return
        }
        const o = [...document.querySelectorAll('[role="option"], [class*="option"]')].find(x => (x.innerText || '').trim() === want)
        o?.scrollIntoView({ block: 'center' }); o?.click()
      }, chosen)
    } else {
      await page.keyboard.press('Escape').catch(() => {})
    }
  }
  const picked = chosen && await until(async () => /Selected Job Position/i.test(await text(page)), 10000, ctx)
  if (picked) log(ctx, `✓ job order: ${chosen} (her Musaned office: ${pro})`)
  else {
    log(ctx, pro ? `no job order matches her Musaned office "${pro}" for sure — left for the person` : 'her Musaned office (PRO) is not known — the job order is left for the person', 'warn')
    left.push(pro ? `Job Order (her office: ${pro})` : 'Job Order')
  }
  const remaining = (await text(page)).match(/Remaining:\s*(\d+)/i)
  if (remaining && Number(remaining[1]) === 0) { log(ctx, 'this job order has 0 remaining', 'warn'); left.push('a job order with places left (Remaining is 0)') }
  await sleep(600)

  // Beginning of Contract: today; Ending of Contract: 2 years later (this PC's date).
  const d = new Date()
  const ymd = (y, m, day) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const today = ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
  const end = new Date(d); end.setFullYear(d.getFullYear() + 2)
  const ending = ymd(end.getFullYear(), end.getMonth() + 1, end.getDate())

  // What her Musaned contract says (saved by the contract check).
  let c = {}
  try { c = JSON.parse(p.contract_data || '{}') } catch {}
  const address = String(p.employer_address || c.Location || '')
  const values = [
    ['Beginning of Contract', today],
    ['Ending of Contract', ending],
    ['Passport Number', p.passport_number || c['Passport Number']],
    ['Visa Number', p.visa_number || c['Visa Number'] || c['Candidate · Visa Number']],
    ['Employer Full Name', p.employer_name],
    ['Employer Phone number', p.employer_phone || c['Mobile Number']],
    ['House Number', (address.match(/^\s*(\d{1,6})\b/) || [])[1]],
  ]
  for (const [label, value] of values) {
    const mark = label.toLowerCase().replace(/\W+/g, '-')
    if (!(await markByLabel(page, label, mark))) continue // this window does not ask it
    const sel = `[data-adal="${mark}"]`
    if (await page.$eval(sel, e => e.value).catch(() => '')) { log(ctx, `${label} already filled — kept`); continue }
    const v = String(value || '').trim()
    if (v && await setInput(page, sel, v)) log(ctx, `✓ ${label}: ${v}`)
    else left.push(label)
  }

  // Employer city: the city of work on the contract, else the city in the employer's address.
  if (await hasLabel(page, 'Employer city')) {
    const wanted = [p.work_city, c['City of Work'], ...citiesIn(address)].filter(Boolean)
    const city = await pickCity(page, ctx, wanted)
    if (city) log(ctx, `✓ Employer city: ${city}`)
    else left.push(`Employer city${wanted.length ? ` (contract: ${wanted[0]})` : ''}`)
  }

  // The employer's second phone is not on the Musaned contract.
  if (await hasLabel(page, 'Alternative Phone Number')) left.push('Alternative Phone Number (if LMIS needs it)')
  return left
}
