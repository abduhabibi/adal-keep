/**
 * robotOneTab.test.js — 2026-11-23: two Musaned runs of one account opened two tabs. Every run is
 * "quiet" (out of sight) since 2026-11-21, and the quiet way to a tab never took the site's tab that
 * an earlier run still held while it waited for a sign-in: it opened a second one beside it.
 * In a real headless Chromium of the test's own (never the PC's Adal Browser); "Musaned" is a local
 * page (the host name is mapped to this PC: nothing reaches the real site). Skipped without Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findChrome, rmTmp } from './helpers/chrome.js'
import http from 'http'

const CHROME = findChrome()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-onetab-'))
process.env.ADAL_NO_BROWSER_START = '1'
process.env.ADAL_BROWSER_PROFILE = path.join(tmp, 'never')
process.env.JEV_ENABLED = 'false'

test('a run takes the site tab a waiting run holds: one Musaned tab, not two', { skip: !CHROME && 'no Chrome on this PC', timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Musaned</title><body>Dashboard</body>') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'profile'),
    args: [`--host-resolver-rules=MAP tawtheeq.musaned.com.sa 127.0.0.1:${port}`, '--no-first-run'] })
  try {
    const tm = await import('../src/services/tabManager.js')
    const url = `http://tawtheeq.musaned.com.sa:${port}/dashboard`
    const wf = 'musaned_add_candidate'
    const onSite = async () => (await browser.pages()).filter(p => p.url().includes('musaned.com.sa')).length

    // Run 1 opens the site's tab, signs in, then waits (paused) for a person.
    const a = await tm.openRunTab(browser, 1, { workflowId: wf, busyRuns: new Set([1]), keepRuns: new Set([1]), quiet: true })
    await a.goto(url, { waitUntil: 'domcontentloaded' })
    tm.handTabToPerson(a)
    // Run 2, same account: run 1 is still a run that needs its tab (paused), but it is not working
    // nor waiting for a Save — it takes that one tab.
    const b = await tm.openRunTab(browser, 2, { workflowId: wf, busyRuns: new Set([1, 2]), keepRuns: new Set([2]), quiet: true })
    assert.equal(b, a, 'the same tab')
    assert.equal(await onSite(), 1)
    tm.forgetRunTab(1)

    // A run waiting on its page for a person's Save keeps its tab: the next one opens its own.
    const c = await tm.openRunTab(browser, 3, { workflowId: wf, busyRuns: new Set([2, 3]), keepRuns: new Set([2, 3]), quiet: true })
    tm.forgetRunTab(3)
    assert.notEqual(c, a)
  } finally {
    await browser.close().catch(() => {})
    server.close()
    rmTmp(tmp)
  }
})
