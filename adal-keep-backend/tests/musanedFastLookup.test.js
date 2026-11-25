/**
 * musanedFastLookup.test.js — "Add from Musaned" faster than a person
 * (asked on 2026-11-23). In a headless Chrome of its own (never the PC's Adal
 * Browser) against a mock of Musaned's HR Pool served through request
 * interception (nothing reaches the real site). The mock keeps a background
 * poll going, like the real site's notifications, so "the whole site has gone
 * quiet" comes late — the old waits paid for that on every search.
 *  1. The first time: searched, her page opened, its address kept.
 *  2. The next time: straight to her page from the kept address, no search.
 *  3. A kept page that no longer shows her: forgotten, searched again.
 *  4. Not in the HR Pool: null, nothing kept.
 * Skipped when this PC has no Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findChrome, rmTmp } from './helpers/chrome.js'

const CHROME = findChrome()
const { herMusanedPage, idOfPassport } = await import('../src/services/musanedImport.js')
const { lookup, remember, forget } = await import('../src/services/robotCache.js')
const { shapeOf } = await import('../src/services/siteApi.js')
const { default: knex } = await import('knex')

const PP = 'EP1234567'
const A = 'https://api-tawtheeq.musaned.com.sa'
const AUTH = "{ headers: { authorization: 'Bearer t', 'app-organization': '7' } }"
const HR = `<!doctype html><html><body>
<app-filter-search><button class="app-filter-header">Passport Number</button><div id="box"></div></app-filter-search>
<table><tbody id="rows"><tr><td class="app-table-value">EQ0000001</td><td><a href="/hr-pool/candidates/11">VIEW</a></td></tr></tbody></table>
<script>
  // The site's own notifications poll: the network is never quiet for long.
  setInterval(() => fetch('/api/notifications').catch(() => {}), 400)
  document.querySelector('.app-filter-header').onclick = () => {
    setTimeout(() => {
      const i = document.createElement('input'); document.getElementById('box').appendChild(i)
      i.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return
        fetch('${A}/api/hrpool?passportNumber=' + i.value + '&page=0', ${AUTH}).then(r => r.json()).then(o => {
          document.getElementById('rows').innerHTML = o.content.map(c => '<tr><td class="app-table-value">' + c.passportNumber + '</td><td><a href="/hr-pool/candidates/' + c.id + '">VIEW</a></td></tr>').join('')
        })
      })
    }, 150)
  }
</script></body></html>`
const HER = `<!doctype html><html><body><h1>Candidate</h1><script>
  const id = location.pathname.split('/').pop()
  fetch('${A}/api/hrpool/' + id, ${AUTH}); fetch('${A}/api/hrpool/' + id + '/photo/PASSPORT', ${AUTH}); fetch('${A}/api/hrpool/' + id + '/photo/PERSONAL', ${AUTH})
  setInterval(() => fetch('/api/notifications').catch(() => {}), 400)
</script></body></html>`
const LIST = `<!doctype html><html><body><script>fetch('${A}/api/search/employment?page=0', ${AUTH})</script></body></html>`

function mock(page, { inPool = true, moved = false } = {}) {
  const seen = { searches: 0, apiSearches: 0, hrPages: 0, herPages: 0 }
  const later = (ms, fn) => new Promise(r => setTimeout(r, ms)).then(fn)
  const cors = { 'access-control-allow-origin': 'https://tawtheeq.musaned.com.sa', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET' }
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.hostname === 'api-tawtheeq.musaned.com.sa') {
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors }).catch(() => {})
      if (!req.headers().authorization) return req.respond({ status: 401, headers: cors, body: '' }).catch(() => {})
      const json = (o, ms = 300) => later(ms, () => req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(o) })).catch(() => {})
      if (u.pathname === '/api/hrpool') {
        seen.searches++
        return json({ content: inPool && u.searchParams.get('passportNumber') === PP ? [{ passportNumber: PP, id: 77 }] : [] }, 900)
      }
      if (u.pathname === '/api/search/employment') return json({ content: [] })
      const m = /^\/api\/hrpool\/(\d+)(\/photo\/(PASSPORT|PERSONAL))?$/.exec(u.pathname)
      if (m) {
        if (m[2]) return later(300, () => req.respond({ status: 200, headers: cors, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) })).catch(() => {})
        return json(m[1] === '77' && !moved ? { passportNumber: PP, name: 'Almaz' } : { passportNumber: 'OTHER1' })
      }
      return json({})
    }
    if (u.hostname !== 'tawtheeq.musaned.com.sa') return req.abort().catch(() => {})
    const html = (body) => later(300, () => req.respond({ status: 200, contentType: 'text/html', body })).catch(() => {})
    if (u.pathname === '/hr-pool') { seen.hrPages++; return html(HR) }
    if (u.pathname.startsWith('/hr-pool/candidates/')) { seen.herPages++; return html(HER) }
    if (u.pathname === '/employment-requests') return html(LIST)
    return later(200, () => req.respond({ status: 200, contentType: 'application/json', body: '{}' })).catch(() => {})
  })
  return seen
}

const fresh = () => knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t] }
const KEY = `musaned_hr:${PP}`, URL77 = 'https://tawtheeq.musaned.com.sa/hr-pool/candidates/77'

test('her Musaned record: pages first time, then Musaned\'s own data calls; the pages when API-first is off', { skip: !CHROME && 'no Chrome on this PC' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'musaned-fast-'))
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'profile'), args: ['--no-first-run', '--no-default-browser-check'] })
  const dbs = []
  const open = async (opts) => { const page = await browser.newPage(); await page.setRequestInterception(true); return [page, mock(page, opts)] }
  try {
    // Clicking only (ADAL_API_FIRST=0): searched once, then her kept page.
    process.env.ADAL_API_FIRST = '0'
    const db0 = fresh(); dbs.push(db0)
    let [page, seen] = await open()
    const [c1, clickFirst] = await timed(() => herMusanedPage(page, db0, PP))
    assert.equal(c1.url, URL77); assert.equal(c1.got.details.passportNumber, PP); assert.ok(c1.got.passport && c1.got.personal)
    const [c2, clickKept] = await timed(() => herMusanedPage(page, db0, PP))
    assert.equal(c2.url, URL77)
    assert.deepEqual([seen.hrPages, seen.herPages], [1, 2])
    await page.close()

    // API-first: the first search is clicked and its call learned; after that no page of hers or of the HR Pool.
    delete process.env.ADAL_API_FIRST
    const db = fresh(); dbs.push(db)
    ;[page, seen] = await open()
    const [a1, apiFirstTime] = await timed(() => herMusanedPage(page, db, PP))
    assert.equal(a1.url, URL77)
    assert.equal((await lookup(db, 'api:musaned:hrpool-search')).url, '/api/hrpool?passportNumber={q}&page=0')
    const pagesBefore = [seen.hrPages, seen.herPages]
    const [a2, apiKept] = await timed(() => herMusanedPage(page, db, PP))
    assert.equal(a2.url, URL77); assert.equal(a2.got.details.passportNumber, PP); assert.ok(a2.got.passport && a2.got.personal)
    assert.deepEqual([seen.hrPages, seen.herPages], pagesBefore, 'her record by id: no pages')
    // Her id not kept (another girl, the same search learned): the search call itself, still no pages.
    await forget(db, KEY)
    const searches = seen.searches
    const [a3, apiSearch] = await timed(() => herMusanedPage(page, db, PP))
    assert.equal(a3.url, URL77)
    assert.equal(seen.searches, searches + 1)
    assert.deepEqual([seen.hrPages, seen.herPages], pagesBefore, 'learned search: no pages')
    console.log(`# clicking: first ${clickFirst} ms, kept page ${clickKept} ms | API-first: first ${apiFirstTime} ms, by id ${apiKept} ms, learned search ${apiSearch} ms`)
    assert.ok(apiKept < clickKept, 'by id faster than her kept page')
    assert.ok(apiSearch < clickFirst, 'learned search faster than the HR Pool page')

    // A kept id that is someone else now: forgotten, the pages find her again.
    await remember(db, KEY, { url: 'https://tawtheeq.musaned.com.sa/hr-pool/candidates/55' })
    const fixed = await herMusanedPage(page, db, PP)
    assert.equal(fixed.url, URL77)
    assert.equal((await lookup(db, KEY)).url, URL77)
    await page.close()

    // Not in the HR Pool (search learned): the data call has no her, the pages say so too; nothing kept.
    const db2 = fresh(); dbs.push(db2)
    await remember(db2, 'api:musaned:hrpool-search', { url: '/api/hrpool?passportNumber={q}&page=0' })
    ;[page, seen] = await open({ inPool: false })
    const none = await herMusanedPage(page, db2, PP)
    assert.equal(none.url, null)
    assert.equal(await lookup(db2, KEY), null)
  } finally {
    delete process.env.ADAL_API_FIRST
    await browser.close().catch(() => {})
    for (const d of dbs) await d.destroy()
    rmTmp(tmp)
  }
})

test('the HR Pool id of exactly her passport, in any shape of answer', () => {
  assert.equal(idOfPassport({ content: [{ passportNumber: 'EQ1', id: 1 }, { passportNumber: 'ep 1234567', id: 9 }] }, PP), 9)
  assert.equal(idOfPassport([{ candidate: { passportNumber: PP, candidateId: 4 } }], PP), 4)
  assert.equal(idOfPassport({ content: [] }, PP), null)
})

test('calls seen: their shape, without what changes from girl to girl', () => {
  assert.equal(shapeOf('get', 'https://api-tawtheeq.musaned.com.sa/api/hrpool/12345/photo/PASSPORT?size=ORIGINAL'), 'GET api-tawtheeq.musaned.com.sa/api/hrpool/:n/photo/PASSPORT?size')
  assert.equal(shapeOf('post', 'https://lmis.gov.et/api/labor/3f2a9c1e-77/docs?id=1&b=2'), 'POST lmis.gov.et/api/labor/:id/docs?b&id')
})
