/**
 * Every page of Adal Keep Admin and every button on it, in a headless browser,
 * on the pretend Supabase (tests/demo.mjs). A button "fails" when the page
 * throws, the console shows an error, or the panel answers 500.
 *
 *   node adal-admin/tests/sweep.mjs [shots-folder]
 *
 * Needs puppeteer (adal-keep-backend/node_modules) and Chrome / Chromium
 * (CHROME=… or /usr/bin/google-chrome). Never a visible window.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startDemo } from './demo.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(HERE, '..', '..', 'adal-keep-backend', 'package.json'))
const puppeteer = require('puppeteer')
const SHOTS = process.argv[2] || null
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(f => fs.existsSync(f))
const ROUTES = ['overview', 'work', 'agencies', 'branches', 'agency/200002', 'agency/400004', 'fleet', 'health', 'robots', 'tickets', 'billing', 'payments', 'plans', 'business', 'releases', 'inbox', 'chats', 'setup', 'cvt', 'agents', 'ceos', 'usage']
// Pressed, but their dialog is cancelled: they would remove what the next buttons need.
const CANCEL = /delete|remove|forget|ban\b|sign out/i
const CRASH = /TypeError|ReferenceError|SyntaxError|is not a function|Cannot read|undefined|ENOENT|ECONN|Unexpected token|"error":"\d+"/
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export async function sweep({ shots = SHOTS, only = null } = {}) {
  const demo = await startDemo()
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900'] })
  const problems = [], clicked = [], told = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const [name, value] = demo.cookie.split('=')
    await page.setCookie({ name, value, domain: '127.0.0.1', path: '/' })
    let where = 'load'
    page.on('pageerror', e => problems.push({ where, what: 'page error', detail: e.message }))
    page.on('console', m => { if (m.type() === 'error' && !/favicon|EventSource|net::ERR|Failed to load resource/.test(m.text())) problems.push({ where, what: 'console', detail: m.text().slice(0, 300) }) })
    // A 500 that tells the person what to type is the panel's answer; one that looks like a crash is a problem.
    const asked = new WeakMap()
    page.on('request', q => asked.set(q, where))
    page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) { const at = asked.get(r.request()) || where; r.text().then(t => (CRASH.test(t) ? problems : told).push({ where: at, what: `${r.status()} ${new URL(r.url()).pathname}`, detail: t.slice(0, 200) })).catch(() => {}) } })
    page.on('dialog', d => d.dismiss().catch(() => {}))
    // A button that opens a window (Open Adal Keep, logs): closed again at once.
    browser.on('targetcreated', async t => { if (t.type() === 'page') { const p = await t.page().catch(() => null); if (p && p !== page) { clicked.push({ where, popup: t.url() }); p.close().catch(() => {}) } } })
    await page.goto(demo.base + '/#/overview', { waitUntil: 'networkidle2' })
    await sleep(800)
    const open = async (r) => { where = r; await page.evaluate((r) => { location.hash = '#/' + r }, r); await sleep(900) }
    for (const r of only || ROUTES) {
      await open(r)
      if (shots) await page.screenshot({ path: path.join(shots, `${r.replace(/\//g, '-')}.png`) })
      const count = await page.evaluate(() => document.querySelectorAll('#table button, #table select, #subnav button, main > header button').length)
      for (let i = 0; i < count; i++) {
        await open(r)
        const b = await page.evaluateHandle((i) => [...document.querySelectorAll('#table button, #table select, #subnav button, main > header button')][i] || null, i)
        const info = await b.evaluate(el => el ? { tag: el.tagName, text: (el.textContent || el.title || '').trim().slice(0, 40), shown: !!(el.offsetWidth || el.offsetHeight), options: el.tagName === 'SELECT' ? [...el.options].map(o => o.value).filter(Boolean) : [] } : null).catch(() => null)
        if (!info || !info.shown) continue
        where = `${r} → ${info.text || info.tag}`
        try {
          if (info.tag === 'SELECT') { if (info.options.length) await b.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })) }, info.options[0]) }
          else await b.evaluate(el => { el.scrollIntoView({ block: 'center' }); el.click() })
        } catch (e) { problems.push({ where, what: 'click', detail: e.message }); continue }
        await sleep(450)
        // Our own question box: answered (cancelled for the ones that remove things).
        for (let k = 0; k < 3; k++) {
          const dlg = await page.evaluate(() => document.querySelector('#dlg')?.style.display === 'flex' ? { t: document.querySelector('#dlgT').textContent, input: document.querySelector('#dlgI').style.display !== 'none', ok: document.querySelector('#dlgOk').textContent } : null)
          if (!dlg) break
          if (CANCEL.test(dlg.t) || CANCEL.test(dlg.ok)) { await page.click('#dlgNo').catch(() => page.evaluate(() => document.querySelector('#dlgOk').click())); break }
          // A form inside the box (payment received): filled like a person would.
          await page.evaluate(() => { const r = document.querySelector('#dlgP #pyRef'); if (r && !r.value) r.value = 'SWEEP' + Math.floor(Math.random() * 1e6) })
          if (dlg.input) await page.evaluate(() => { const I = document.querySelector('#dlgI'); if (!I.value) I.value = /number/i.test(document.querySelector('#dlgP').textContent) ? '1' : 'Demo note from the sweep' })
          await page.evaluate(() => document.querySelector('#dlgOk').click())
          await sleep(500)
        }
        await page.evaluate(() => { if (document.querySelector('#dlg').style.display === 'flex') document.querySelector('#dlgNo').click() })
        await page.evaluate(() => { document.querySelector('#pal')?.classList.remove('on'); document.querySelector('#keys')?.classList.remove('on'); document.querySelector('#zoom').style.display = 'none' })
        clicked.push({ where })
      }
    }
    // The search, the shortcuts, the theme.
    where = 'search'
    await open('overview')
    await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control')
    await page.type('#palI', 'EP1002'); await sleep(900)
    const found = await page.evaluate(() => [...document.querySelectorAll('#palR .it .t')].map(e => e.textContent))
    if (!found.some(t => /Hiwot/.test(t))) problems.push({ where, what: 'search', detail: `no candidate found: ${found.join(', ')}` })
    if (shots) await page.screenshot({ path: path.join(shots, 'search.png') })
    await page.keyboard.press('Enter'); await sleep(900)
    if (!(await page.evaluate(() => location.hash)).startsWith('#/agency/')) problems.push({ where, what: 'search', detail: 'Enter did not open the agency' })
    if (shots) await page.screenshot({ path: path.join(shots, 'agency-from-search.png'), fullPage: true })
    where = 'shortcuts'
    await page.keyboard.press('Escape'); await page.keyboard.press('g'); await page.keyboard.press('u'); await sleep(900)
    if ((await page.evaluate(() => location.hash)) !== '#/releases') problems.push({ where, what: 'g u', detail: await page.evaluate(() => location.hash) })
    await page.goBack(); await sleep(700)
    if (!(await page.evaluate(() => location.hash)).startsWith('#/agency/')) problems.push({ where, what: 'Back', detail: await page.evaluate(() => location.hash) })
    await page.keyboard.press('?'); await sleep(300)
    if (shots) await page.screenshot({ path: path.join(shots, 'shortcuts.png') })
    await page.keyboard.press('Escape')
    where = 'theme'
    await open('overview')
    const before = await page.evaluate(() => document.documentElement.dataset.theme)
    await page.keyboard.press('t'); await sleep(400)
    const after = await page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor])
    if (after[0] === before) problems.push({ where, what: 't', detail: 'theme did not change' })
    if (shots) { await page.screenshot({ path: path.join(shots, `overview-${after[0]}.png`) }); await open('releases'); await page.screenshot({ path: path.join(shots, `releases-${after[0]}.png`) }); await open('agency/200002'); await page.screenshot({ path: path.join(shots, `agency-${after[0]}.png`), fullPage: true }) }
    // Live: a change in "Supabase" shows without a reload.
    where = 'live'
    await open('overview')
    const t0 = await page.evaluate(() => document.querySelector('.tile[data-go=tickets] .num-xl')?.textContent)
    const row = demo.fake.tables.keep_meta.find(r => r.key === '/_tower/tickets' && r.data.tickets.length === 1)
    row.data.tickets.push({ id: '11111111-2222-4333-8444-555555555555', at: new Date().toISOString(), status: 'open', replies: [], text: 'Live test ticket', agency: 'Selam', pc_name: 'SELAM-MAIN' }); row.updated_at = new Date().toISOString()
    let t1 = t0
    for (let k = 0; k < 20 && t1 === t0; k++) { await sleep(500); t1 = await page.evaluate(() => document.querySelector('.tile[data-go=tickets] .num-xl')?.textContent) }
    if (t1 === t0) problems.push({ where, what: 'live', detail: `open tickets stayed ${t0}` })
    else clicked.push({ where: `live: tickets ${t0} → ${t1} without a reload` })
    return { problems, clicked, told, log: demo.log() }
  } finally { await browser.close().catch(() => {}); demo.stop() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  const r = await sweep()
  console.log(`clicked ${r.clicked.length} controls; ${r.problems.length} problem(s)`)
  for (const t of r.told) console.log(`  · told: ${t.where}: ${t.detail}`)
  for (const p of r.problems) console.log(`  ✗ ${p.where}: ${p.what} — ${p.detail}`)
  for (const c of r.clicked.filter(c => c.where.startsWith('live'))) console.log(`  ✓ ${c.where}`)
  process.exitCode = r.problems.length ? 1 : 0
}
