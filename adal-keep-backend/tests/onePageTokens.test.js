/**
 * onePageTokens.test.js — 2026-11-25, Main, run 1795614900465001: the contracts check had the Musaned page, the run
 * opened a second tab "signed in from another tab" (its sessionStorage copied), Musaned signed out. A mock site whose
 * sign-in rotates its refresh token every refresh and signs the whole session out when an old one comes back (as
 * Keycloak does with refresh-token rotation): the old way loses the sign-in, one page a site keeps it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import https from 'https'
import { execFileSync } from 'child_process'
import { findChrome, rmTmp } from './helpers/chrome.js'
const CHROME = findChrome()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.ADAL_NO_BROWSER_START = '1'

// The app: its refresh token in sessionStorage, refreshed every 400 ms; refused → it signs out.
const APP = `<!doctype html><body><nav><a>Dashboard</a> <a>Organizations</a> <a>HR Pool</a></nav><p>${'Latest requests and candidates. '.repeat(4)}</p><script>
async function refresh() {
  const r = await fetch('/token?rt=' + encodeURIComponent(sessionStorage.getItem('rt') || ''), { method: 'POST' })
  if (r.status !== 200) { location.href = 'https://accounts.wahid.sa/auth/realms/wahid/protocol/openid-connect/logout?redirect_uri=x'; return }
  sessionStorage.setItem('rt', await r.text()); setTimeout(refresh, 400)
}
refresh()</script>`

test('a run beside a check that has the page: the old way is signed out, one page a site is not', { skip: !CHROME && 'no Chrome', timeout: 90000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-tokens-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k`, '-out', `${tmp}/c`, '-days', '2', '-subj', '/CN=m'], { stdio: 'ignore' })
  let current = '', n = 0, revoked = 0, outs = 0
  const srv = https.createServer({ key: fs.readFileSync(`${tmp}/k`), cert: fs.readFileSync(`${tmp}/c`) }, (q, r) => {
    const u = new URL(q.url, 'https://x')
    if (/logout/.test(u.pathname)) { outs++; r.end('signed out'); return }
    if (u.pathname === '/token') {
      const rt = u.searchParams.get('rt')
      // A new sign-in when there is none; the current one → the next; an old one → the session ends (rotation).
      if (current === 'revoked' || (rt && rt !== current)) { if (current !== 'revoked') revoked++; current = 'revoked'; r.writeHead(401); return r.end() }
      if (!rt && current) { r.writeHead(401); return r.end() }
      current = `rt-${++n}`; return r.end(current)
    }
    r.setHeader('content-type', 'text/html'); r.end(APP)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), defaultViewport: null,
    args: ['--no-first-run', '--disable-gpu', '--ignore-certificate-errors', `--host-resolver-rules=MAP * 127.0.0.1:${srv.address().port}`] })
  t.after(async () => { await b.close().catch(() => {}); srv.close(); srv.closeAllConnections(); rmTmp(tmp); delete process.env.ADAL_ONE_PAGE })
  const tm = await import('../src/services/tabManager.js')
  const musaned = async () => (await b.pages()).filter(p => /musaned/.test(p.url()))

  const once = async (off, runId) => {
    if (off) process.env.ADAL_ONE_PAGE = '0'; else delete process.env.ADAL_ONE_PAGE
    current = ''; revoked = 0; outs = 0
    for (const p of await b.pages()) if (/musaned/.test(p.url())) await p.close()
    // Signed in in the site's one tab.
    const a = await b.newPage(); await tm.setupTab(a); await a.goto('https://tawtheeq.musaned.com.sa/dashboard'); await sleep(1500)
    // The check for newly chosen girls takes it, and gives way when asked (as musanedContracts.js does).
    let asked = 0
    const page = await tm.borrowTab(b, 'musaned_check_chosen', new Set(), null, { giveWay: () => { asked++; setTimeout(() => tm.doneWithTab(page), 300) } })
    assert.equal(page, a)
    const t0 = Date.now()
    const run = await tm.openRunTab(b, runId, { workflowId: 'musaned_check_chosen', busyRuns: new Set([runId]) })
    if (run !== a) await run.goto('https://tawtheeq.musaned.com.sa/hr-pool').catch(() => {})
    await sleep(3000)
    const r = { same: run === a, waited: Date.now() - t0 - 3000, revoked, outs, tabs: (await musaned()).length, asked, stopped: !!(a.__adalSignOutStopped || run.__adalSignOutStopped) }
    tm.forgetRunTab(runId)
    if (off) await tm.doneWithTab(page)
    return r
  }
  const before = await once(true, 71), now = await once(false, 72)
  console.log('before:', JSON.stringify(before), '\nnow:   ', JSON.stringify(now))
  assert.equal(before.same, false); assert.ok(before.revoked >= 1, 'the old way: an old refresh token came back, the sign-in ended')
  assert.equal(now.same, true, 'the run took the one page'); assert.equal(now.asked, 1, 'the check was asked to give way')
  assert.equal(now.revoked, 0, 'the sign-in stays'); assert.equal(now.tabs, 1); assert.equal(now.outs, 0)
  assert.ok(now.waited < 5000, `it waited ${now.waited} ms`)
})
