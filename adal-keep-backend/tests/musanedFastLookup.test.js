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

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(f => fs.existsSync(f))
const { herMusanedPage } = await import('../src/services/musanedImport.js')
const { lookup, remember } = await import('../src/services/robotCache.js')
const { default: knex } = await import('knex')

const PP = 'EP1234567'
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
        fetch('/api/hrpool/search?p=' + i.value).then(r => r.json()).then(list => {
          document.getElementById('rows').innerHTML = list.map(c => '<tr><td class="app-table-value">' + c.pp + '</td><td><a href="/hr-pool/candidates/' + c.id + '">VIEW</a></td></tr>').join('')
        })
      })
    }, 150)
  }
</script></body></html>`
const HER = `<!doctype html><html><body><h1>Candidate</h1><script>
  const id = location.pathname.split('/').pop()
  fetch('/api/hrpool/' + id); fetch('/api/hrpool/' + id + '/photo/PASSPORT'); fetch('/api/hrpool/' + id + '/photo/PERSONAL')
  setInterval(() => fetch('/api/notifications').catch(() => {}), 400)
</script></body></html>`

function mock(page, { inPool = true, moved = false } = {}) {
  const seen = { searches: 0 }
  const later = (ms, fn) => new Promise(r => setTimeout(r, ms)).then(fn)
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.hostname !== 'tawtheeq.musaned.com.sa') return req.abort().catch(() => {})
    const json = (o, ms = 300) => later(ms, () => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })).catch(() => {})
    if (u.pathname === '/hr-pool') return later(300, () => req.respond({ status: 200, contentType: 'text/html', body: HR })).catch(() => {})
    if (u.pathname.startsWith('/hr-pool/candidates/')) return later(300, () => req.respond({ status: 200, contentType: 'text/html', body: HER })).catch(() => {})
    if (u.pathname === '/api/hrpool/search') { seen.searches++; return json(inPool ? [{ pp: PP, id: 77 }] : [], 900) }
    const m = /^\/api\/hrpool\/(\d+)(\/photo\/(PASSPORT|PERSONAL))?$/.exec(u.pathname)
    if (m) {
      if (m[2]) return later(300, () => req.respond({ status: 200, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) })).catch(() => {})
      const shows = m[1] === '77' && !moved
      return json(shows ? { passportNumber: PP, name: 'Almaz' } : { passportNumber: 'OTHER1' })
    }
    return json({ ok: true }, 200)
  })
  return seen
}

test('her Musaned page: searched once, then straight from the kept address', { skip: !CHROME && 'no Chrome on this PC' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'musaned-fast-'))
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'profile'), args: ['--no-first-run', '--no-default-browser-check'] })
  const timed = async (fn) => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t] }
  try {
    const page = await browser.newPage()
    await page.setRequestInterception(true)
    let seen = mock(page)

    const [first, firstMs] = await timed(() => herMusanedPage(page, db, PP))
    assert.equal(first.url, 'https://tawtheeq.musaned.com.sa/hr-pool/candidates/77')
    assert.equal(first.got.details.passportNumber, PP)
    assert.ok(first.got.passport && first.got.personal)
    assert.equal(seen.searches, 1)
    assert.equal((await lookup(db, `musaned_hr:${PP}`)).url, first.url)

    const [again, againMs] = await timed(() => herMusanedPage(page, db, PP))
    assert.equal(again.url, first.url)
    assert.equal(seen.searches, 1, 'no search the second time')
    console.log(`# first (search + her page): ${firstMs} ms; again (kept address): ${againMs} ms`)
    assert.ok(againMs < firstMs, 'the kept address is faster')

    // Her kept page shows someone else now: forgotten, searched again, kept anew.
    await remember(db, `musaned_hr:${PP}`, { url: 'https://tawtheeq.musaned.com.sa/hr-pool/candidates/55' })
    const fixed = await herMusanedPage(page, db, PP)
    assert.equal(fixed.url, first.url)
    assert.equal(seen.searches, 2)
    assert.equal((await lookup(db, `musaned_hr:${PP}`)).url, first.url)
    await page.close()

    // Not in the HR Pool: null, nothing kept.
    const p2 = await browser.newPage()
    await p2.setRequestInterception(true)
    seen = mock(p2, { inPool: false })
    const db2 = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    const none = await herMusanedPage(p2, db2, PP)
    assert.equal(none.url, null)
    assert.equal(await lookup(db2, `musaned_hr:${PP}`), null)
    await db2.destroy()
  } finally {
    await browser.close().catch(() => {})
    await db.destroy()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
