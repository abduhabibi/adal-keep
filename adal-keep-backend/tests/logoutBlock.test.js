/**
 * logoutBlock.test.js — the owner, 2026-11-24: "keep every login for a day". A robot tab never goes to Musaned's
 * sign-out address by itself (the site's page tried it when its sign-in refresh failed on a dropped line);
 * Adal Keep's own account switch still can. In a headless browser of the test's own; "wahid.sa" is a local
 * page. Skipped without a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'

const EXE = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/brave.com/brave/brave'].find(f => fs.existsSync(f))
process.env.JEV_ENABLED = 'false'

test("a site's own sign-out is stopped in robot tabs; Adal Keep's own account switch is not", { skip: !EXE && 'no browser', timeout: 60000 }, async () => {
  const hits = []
  const site = http.createServer((req, res) => { hits.push(req.url); res.setHeader('content-type', 'text/html'); res.end('<title>x</title>ok') })
  await new Promise(r => site.listen(0, '127.0.0.1', r))
  const port = site.address().port
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-logout-'))
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: EXE, headless: true, userDataDir: tmp, args: ['--no-first-run', `--host-resolver-rules=MAP accounts.wahid.sa 127.0.0.1:${port}`, '--ignore-certificate-errors'] })
  try {
    const { setupTab } = await import('../src/services/tabManager.js')
    const page = await browser.newPage()
    await setupTab(page)
    // http in the test (the rule is for https): the same address with https is what Musaned uses.
    const out = `https://accounts.wahid.sa/auth/realms/wahid/protocol/openid-connect/logout?client_id=etawtheeq-fe`
    await page.goto(out, { timeout: 10000 }).catch(() => {})
    assert.ok(!hits.some(h => /logout/.test(h)), 'the sign-out never reached the site')
    const local = out.replace('https:', 'http:').replace('accounts.wahid.sa', `accounts.wahid.sa:${port}`)
    await page.goto(local, { timeout: 10000 }).catch(() => {})
    assert.ok(!hits.some(h => /logout/.test(h)), 'stopped on http too')
    page.__adalMayLogOut = true
    await page.goto(out.replace('https:', 'http:').replace('accounts.wahid.sa', `accounts.wahid.sa:${port}`), { timeout: 10000 }).catch(() => {})
    assert.ok(hits.some(h => /logout/.test(h)), "Adal Keep's own sign-out goes through")
  } finally { await browser.close().catch(() => {}); site.close(); fs.rmSync(tmp, { recursive: true, force: true }) }
})
