/**
 * labelTab.test.js — 2026-11-23, this PC: every Musaned run's tab froze ("[nuzla]", empty address, its page at
 * 100 % of a core; "smooth-scroll override failed: no answer in 5 s", "Network.enable timed out", "Requesting
 * main frame too early!"). The account label on a page with no title was set again and again for ever.
 * In a headless Chrome of the test's own. Skipped without one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const EXE = process.env.TEST_BROWSER || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/brave-browser'].find(f => fs.existsSync(f))

test('the account label on a page with no title: the tab keeps answering', { skip: !EXE && 'no browser', timeout: 60000 }, async () => {
  const puppeteer = (await import('puppeteer-core')).default
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-label-'))
  const browser = await puppeteer.launch({ executablePath: EXE, headless: true, userDataDir: tmp, args: ['--no-first-run'], protocolTimeout: 10000 })
  try {
    const { labelTab } = await import('../src/services/robotCheck.js')
    const { disableSmoothScroll } = await import('../src/services/musanedWorkflow.js')
    const page = await browser.newPage()
    // As a Musaned run does: its label on the blank new tab, then the next script for each page.
    await labelTab(page, 'nuzla')
    await disableSmoothScroll(page, { log: () => {}, onLog: () => {} })
    const answer = await Promise.race([page.evaluate(() => document.title), new Promise(r => setTimeout(() => r('NO ANSWER'), 3000))])
    assert.equal(answer, '[nuzla]')
    await page.goto('data:text/html,<title>Musaned</title><body>x</body>')
    await page.evaluate(() => { document.title = 'Dashboard' })
    await new Promise(r => setTimeout(r, 100))
    assert.equal(await page.evaluate(() => document.title), '[nuzla] Dashboard')
  } finally {
    await browser.close().catch(() => {})
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
