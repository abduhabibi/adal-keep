/**
 * pageGone.test.js — a check whose Musaned tab is gone stops at once and says so, with what closed it (2026-11-26,
 * Main: the contracts check failed on every girl with the same "detached Frame").
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findChrome, rmTmp } from './helpers/chrome.js'
import { pageGone, closedBy } from '../src/services/pageGone.js'
const CHROME = findChrome()
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'

test('the list read stops at the first girl when its tab is gone: one line, not one failure a girl', async () => {
  const { scanRows } = await import('../src/services/musanedContracts.js')
  const girls = [1, 2, 3].map(i => ({ id: i, full_name: `GIRL NUMBER ${i} TEST`, passport_number: `EP00000${i}` }))
  const db = (t) => ({ select: async () => girls, where: () => ({ update: async () => 1, first: async () => null }) })
  const rows = girls.map((g, i) => ({ id: 100 + i, candidateId: 0, candidateName: g.full_name, passportNumber: g.passport_number, status: 'NEW', orderNumber: `C${i}` }))
  let asked = 0
  const src = {
    gone: (e) => pageGone({ isClosed: () => true, __adalClosedBy: 'the dead-tab look (it answered nothing)' }, e),
    api: async () => ({ status: 200, json: { content: rows } }),
    contract: async () => { asked++; throw new Error("Attempted to use detached Frame 'F0FE'") },
    pdf: async () => { throw new Error('no') },
  }
  const logs = []
  await assert.rejects(scanRows(db, src, { log: (m) => logs.push(m) }), (e) => e.pageGone === true && /closed by the dead-tab look/.test(e.message))
  assert.equal(asked, 1, 'the second and third girls are not tried')
  assert.equal(logs.filter(l => /tab is gone/.test(l)).length, 1)
})

test('a page closed, crashed, or there', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-gone-'))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu'] })
  t.after(async () => { await b.close().catch(() => {}); rmTmp(tmp) })
  const p = await b.newPage(); await p.goto('data:text/html,<p>x')
  assert.equal(pageGone(p), '')
  assert.equal(pageGone(p, new Error('Musaned answered 500')), '')
  closedBy(p, 'spare tabs (a second Musaned tab)')
  await p.close()
  const e = await p.evaluate(() => 1).then(() => null, (x) => x)
  assert.match(pageGone(p, e), /tab is gone \(closed by spare tabs/)
  process.env.ADAL_PAGE_GONE = '0'
  try { assert.equal(pageGone(p, e), '') } finally { delete process.env.ADAL_PAGE_GONE }
})
