/**
 * musanedSlowPages.test.js — Robot history, 2026-11-24: three runs failed "Agency card was not there" with Musaned's
 * list of agencies still spinning after 20 s; one run started again after a restart in its tab still on its Add
 * Candidate form and failed "ADD NEW CANDIDATE was not there". Local pages stand for Musaned.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'

process.env.JEV_ENABLED = 'false'
process.env.ADAL_NO_BROWSER_START = '1'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'   // never the PC's own robot browser
const EXE = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/brave.com/brave/brave'].find(f => fs.existsSync(f))

test('plain words: a slow Musaned is not "the site changed"', async () => {
  const { plainReason } = await import('../src/services/runOutcome.js')
  assert.match(plainReason("Agency card not found: Musaned's list of agencies kept loading for 90 s (loaded again once). Nothing was filled. Try again when Musaned answers."), /kept loading: nothing was filled/)
  assert.match(plainReason('Musaned did not open the Add Candidate form after the passport check (its page kept loading). Nothing was filled.'), /did not open the Add Candidate form/)
})

test('the agency list that spins 25 s is waited for; a tab left on the Add form goes back to the list', { skip: !EXE && 'no browser', timeout: 120000 }, async () => {
  const LIST_AFTER_MS = 25000
  const site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url.startsWith('/login')) return res.end(`<!doctype html><body><p>Please select the establishment:</p><div id="l">loading…</div>
      <script>setTimeout(() => { const t = ['ZADUL', 'MEAD FOR', 'EIGN EMPLOY', 'MENT AGE', 'NCY PLC det', 'ails'].join(''); document.getElementById('l').innerHTML = '<div id="card" style="width:500px;height:120px;border:1px solid" onclick="window.picked=1">' + t + '</div>' }, ${LIST_AFTER_MS})</script></body>`)
    if (req.url.startsWith('/hr-pool/candidates/add')) return res.end('<!doctype html><body><h1>Add Candidate</h1><input value="E00384116"></body>')
    if (req.url.startsWith('/hr-pool')) return res.end('<!doctype html><body><h1>Candidates</h1><button onclick="window.added=1">Add New Candidate</button></body>')
    res.end('<!doctype html><body>home</body>')
  })
  await new Promise(r => site.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${site.address().port}`
  const puppeteer = (await import('puppeteer-core')).default
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-slowmus-'))
  const b = await puppeteer.launch({ executablePath: EXE, headless: true, userDataDir: dir, args: ['--no-first-run'] })
  try {
    const w = await import('../src/services/musanedWorkflow.js')
    const logs = []
    const ctx = { musaned_name: 'zadulmead', onLog: (l, m) => logs.push(m), profileName: 'Test' }
    const p = await b.newPage()
    await p.goto(`${base}/login`)
    const t0 = Date.now()
    await w.stepClickAgencyCard(p, ctx)
    assert.equal(await p.evaluate(() => window.picked), 1, 'the card was clicked once it showed')
    assert.ok(Date.now() - t0 >= LIST_AFTER_MS - 1000, 'it waited for the list')

    await p.goto(`${base}/hr-pool/candidates/add`)
    await w.stepClickAddNewCandidate(p, ctx)
    assert.ok(/\/hr-pool$/.test(new URL(p.url()).pathname), 'back on the HR Pool list')
    assert.equal(await p.evaluate(() => window.added), 1, 'Add New Candidate pressed')
  } finally { await b.close(); site.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
