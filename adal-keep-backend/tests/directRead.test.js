/**
 * directRead.test.js — Musaned's list read with the tab's own data headers: the first read loads the list page once
 * (its headers are seen), the next ones only call Musaned's data — no page load — with the same answer; refused kept
 * headers load the page once more; ADAL_DIRECT_READ=0: no data call (the pages of before). Mock Musaned in a real
 * Chrome (every request answered in the test) and an in-memory database.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'
import { findChrome, rmTmp } from './helpers/chrome.js'
const CHROME = findChrome()
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'

const APP = `<!doctype html><body>Employment Requests<script>fetch('https://api-tawtheeq.musaned.com.sa/api/search/employment?sort=createdAt,DESC&page=0&size=10', { headers: { authorization: 'Bearer ' + (window.T || 'tok1'), 'app-organization': '42' } })</script>`

test('Musaned list: no page load once its headers are seen', { skip: !CHROME && 'no Chrome', timeout: 90000 }, async (t) => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 }, migrations: { directory: new URL('../src/migrations', import.meta.url).pathname } })
  await db.migrate.latest()
  await db('profiles').insert({ full_name: 'AMINA ALI HASSEN', passport_number: 'EP1111111', status: 'active', chosen_at: '2026-11-01', musaned_stage: 'EPRO APPROVAL', contract_number: '2005000001', created_at: new Date().toISOString() })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-direct-'))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu'] })
  t.after(async () => { await b.close().catch(() => {}); rmTmp(tmp); await db.destroy(); delete process.env.ADAL_DIRECT_READ })
  const D = await import('../src/services/directRead.js')
  const C = await import('../src/services/musanedContracts.js')
  const page = await b.newPage()
  await page.setRequestInterception(true)
  let loads = 0, good = 'tok1'
  const rows = [{ id: 1, candidateId: 0, orderNumber: '2005000001', candidateName: 'AMINA ALI HASSEN', passportNumber: 'EP1111111', status: 'EPRO_APPROVAL_PENDING' }]
  page.on('request', (q) => {
    D.noteHeaders(page, q)
    const u = new URL(q.url())
    if (q.method() === 'OPTIONS') return q.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (u.host === 'api-tawtheeq.musaned.com.sa') {
      const ok = q.headers().authorization === 'Bearer ' + good
      return q.respond({ status: ok ? 200 : 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ content: /page=0/.test(u.search) ? rows : [] }) })
    }
    if (u.host === 'tawtheeq.musaned.com.sa') { if (q.resourceType() === 'document') loads++; return q.respond({ status: 200, contentType: 'text/html', body: APP.replace("(window.T || 'tok1')", `'${good}'`) }) }
    q.abort()
  })
  const read = async () => { const t0 = Date.now(); const r = await C.scanListByApi(db, page, { log: () => {} }); return { ...r, ms: Date.now() - t0 } }
  const first = await read()
  assert.equal(first.ok, true, first.why); assert.equal(loads, 1)
  const second = await read()
  assert.equal(second.ok, true); assert.equal(loads, 1, 'no page load'); assert.equal(second.checked, first.checked)
  console.log(`Musaned list, mock: first read (page load + data) ${first.ms} ms, then the data call alone ${second.ms} ms`)
  // The sign-in renewed: the kept headers are refused, the page is loaded once for fresh ones.
  good = 'tok2'
  const third = await read()
  assert.equal(third.ok, true, third.why); assert.equal(loads, 2)
  // Off: no data call at all.
  process.env.ADAL_DIRECT_READ = '0'
  const off = await C.scanListByApi(db, page, {})
  assert.equal(off.ok, false); assert.match(off.why, /ADAL_DIRECT_READ=0/)
})
