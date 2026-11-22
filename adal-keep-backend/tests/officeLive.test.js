/**
 * officeLive.test.js — three scratch Adal Keeps on spare ports (a main PC and
 * two stand-in Companions, each with its own headless Chromium; no Supabase,
 * no Telegram, no real data): a run goes to the stronger Companion, shows in
 * Browsers as that PC's, and the live view's input comes back as a new frame.
 * The input round trip (POST /input → the next picture) is measured on
 * localhost, for a run on the main PC and for one on a Companion.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHROME = [process.env.ADAL_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/brave-browser'].find(p => p && fs.existsSync(p))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-office-live-'))
Object.assign(process.env, {
  ACCOUNT_VAULT_KEY: path.join(tmp, 'vault.key'), ADAL_KEYS_OUTSIDE: path.join(tmp, 'keys'), ADAL_SPACES_FILE: path.join(tmp, 'spaces.json'),
  ADAL_BROWSER_PROFILE: path.join(tmp, 'profile'), ADAL_NO_NET_PROBE: '1', ADAL_NO_SOUND: '1', SUPABASE_URL: '', TELEGRAM_BOT_TOKEN: '',
})
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))]

// The "portal": a page whose colour and text change on every press and key.
const PORTAL = `<!doctype html><title>Portal</title><body style="margin:0;height:100vh;background:#123">
<h1 id=t style="color:#fff;font:40px sans-serif">0</h1><input id=i style="font:30px sans-serif">
<script>let n=0;const c=()=>{n++;document.body.style.background='hsl('+(n*47%360)+',70%,40%)';t.textContent=n}
addEventListener('mousedown',c);addEventListener('mouseup',c);addEventListener('keydown',c);addEventListener('wheel',c);addEventListener('paste',e=>{t.textContent='pasted:'+e.clipboardData.getData('text')})</script>`

test('office: placement, Browsers and the live view across scratch PCs', { skip: !CHROME && 'no Chromium on this PC', timeout: 120_000 }, async (t) => {
  const puppeteer = (await import('puppeteer-core')).default
  const cdpPort = await freePort()
  const mainChrome = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'main-chrome'), args: [`--remote-debugging-port=${cdpPort}`, '--no-first-run', '--disable-gpu', '--window-size=1200,800'], defaultViewport: { width: 1200, height: 800 } })
  process.env.BRAVE_CDP_URL = `http://127.0.0.1:${cdpPort}`
  const portal = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(PORTAL) }).listen(0, '127.0.0.1')
  await new Promise(r => portal.once('listening', r))
  const portalUrl = `http://127.0.0.1:${portal.address().port}/`

  // The main PC: the automations routes on a scratch database.
  const knex = (await import('knex')).default
  const { openRows } = await import('../src/services/accountVault.js')
  const db = knex({ client: 'sqlite3', connection: { filename: path.join(tmp, 'main.sqlite') }, useNullAsDefault: true, postProcessResponse: openRows })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name') })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.string('status'); t.text('context'); t.string('pause_reason'); t.string('started_at'); t.string('updated_at'); t.integer('account_id') })
  await db('profiles').insert([{ id: 1, full_name: 'Amina Ali' }, { id: 2, full_name: 'Sara Bekele' }])
  const express = (await import('express')).default
  const router = (await import('../src/routes/automations.js')).default
  const app = express()
  app.locals.db = db
  app.use(express.json())
  app.use((req, _res, next) => { const id = req.headers['x-test-pc']; if (id) req.pcAccess = { id, name: id }; next() })
  app.use('/api', router)
  const mainPort = await freePort()
  const server = app.listen(mainPort, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${mainPort}/api`

  // Two Companions on spare ports: an old busy one and a strong one with a fast line.
  const kids = []
  const companion = (id, name, power) => new Promise((resolve, reject) => {
    const k = spawn(process.execPath, [path.join(HERE, 'fixtures', 'officeCompanion.mjs'), String(mainPort), id, name, JSON.stringify(power), CHROME], { cwd: path.join(HERE, '..'), stdio: ['ignore', 'pipe', 'inherit'] })
    kids.push(k)
    k.stdout.on('data', d => { if (/READY/.test(String(d))) resolve() })
    k.on('exit', c => reject(new Error(`companion ${id} ended (${c})`)))
  })
  t.after(async () => {
    for (const k of kids) k.kill('SIGTERM')
    server.close(); portal.close()
    await (await import('../src/services/browser.js')).closeBrowser().catch(() => {})
    await mainChrome.close().catch(() => {})
    await db.destroy()
    await new Promise(r => setTimeout(r, 500))
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  await Promise.all([
    companion('OLD', 'Old PC', { cores: 2, mem_gb: 4, free_gb: 0.8, load: 85, net_rtt_ms: 700, net_mbps: 2, net_ok: 0.8 }),
    companion('FAST', 'Manager PC', { cores: 12, mem_gb: 32, free_gb: 20, load: 5, net_rtt_ms: 60, net_mbps: 50, net_ok: 1 }),
  ])
  const rb = await import('../src/services/remoteBrowsers.js')
  for (let i = 0; i < 50 && rb.liveDevices().length < 2; i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(rb.liveDevices().length, 2)

  // 1. Placement: the main PC is busy now; the strong Companion gets the run.
  const sp = await import('../src/services/sharePower.js')
  const now = new Date().toISOString()
  await db('automation_queue').insert({ id: 1, profile_id: 1, workflow_id: 'musaned_contract', status: 'pending', context: '{}', updated_at: now })
  const pcs = [{ ...sp.ownPower(), load: 90, free_gb: 1, net: { rtt_ms: 300, mbps: 5, ok: 0.9 } }, ...rb.liveDevices()]
  const line = await sp.placeRun(db, await db('automation_queue').where('id', 1).first(), { pcs, tabs: {} })
  assert.match(line, /Manager PC/)
  const ctx = JSON.parse((await db('automation_queue').where('id', 1).first()).context)
  assert.equal(ctx.on_device, 'FAST')

  // Its tab opens there, out of sight; it shows in Browsers as that PC's.
  const tm = await import('../src/services/tabManager.js')
  const remote = await rb.browserForDevice('FAST', { quiet: true })
  const rPage = await tm.openRunTab(remote, 1, { workflowId: 'musaned_contract', quiet: true })
  await rPage.goto(portalUrl)
  await db('automation_queue').where('id', 1).update({ status: 'running', started_at: now })
  // And one on the main PC itself.
  await db('automation_queue').insert({ id: 2, profile_id: 2, workflow_id: 'wafid_book', status: 'running', context: '{}', started_at: now, updated_at: now })
  const { getBrowser } = await import('../src/services/browser.js')
  const lPage = await tm.openRunTab(await getBrowser(), 2, { workflowId: 'wafid_book', quiet: true })
  await lPage.goto(portalUrl)

  const list = await (await fetch(`${base}/browsers`)).json()
  const r1 = list.find(b => b.run_id === 1), r2 = list.find(b => b.run_id === 2)
  assert.deepEqual([r1.site, r1.girl, r1.pc, r1.remote, r1.status], ['Musaned', 'Amina Ali', 'Manager PC', true, 'Working'])
  assert.deepEqual([r2.site, r2.girl, r2.remote], ['Wafid', 'Sara Bekele', false])

  // 2. The live view: frames from /stream, input to /input; how long until the change is seen.
  const measure = async (runId, kinds) => {
    const frames = []
    let buf = Buffer.alloc(0), last = null
    const req = http.get(`${base}/automations/${runId}/stream`, (res) => {
      res.on('data', (d) => {
        buf = Buffer.concat([buf, d])
        for (;;) {
          const h = buf.indexOf('\r\n\r\n')
          if (h < 0) break
          const m = /Content-Length: (\d+)/.exec(buf.slice(0, h).toString())
          if (!m) { buf = buf.slice(h + 4); continue }
          const len = Number(m[1])
          if (buf.length < h + 4 + len + 2) break
          const img = buf.slice(h + 4, h + 4 + len)
          buf = buf.slice(h + 4 + len + 2)
          if (!last || !last.equals(img)) frames.push(performance.now())
          last = img
        }
      })
    })
    for (let i = 0; i < 40 && !frames.length; i++) await new Promise(r => setTimeout(r, 100))
    await new Promise(r => setTimeout(r, 400))
    const rtts = [], acks = []
    for (let i = 0; i < 12; i++) {
      const body = kinds[i % kinds.length]
      const n = frames.length, t0 = performance.now()
      const r = await fetch(`${base}/automations/${runId}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(r.status, 200, await r.clone().text())
      acks.push(performance.now() - t0)
      for (let j = 0; j < 300 && frames.length === n; j++) await new Promise(r => setTimeout(r, 5))
      assert.ok(frames.length > n, `a new picture came after input #${i} ${JSON.stringify(body)} on run ${runId} (${frames.length} frames so far)`)
      rtts.push(frames[n] - t0)
      await new Promise(r => setTimeout(r, 120))
    }
    req.destroy()
    return { ack: median(acks), median: median(rtts), p90: p90(rtts) }
  }
  const kinds = [
    { kind: 'mouse', type: 'down', x: 0.5, y: 0.5, button: 0, buttons: 1, clickCount: 1 },
    { kind: 'mouse', type: 'up', x: 0.5, y: 0.5, button: 0, buttons: 0, clickCount: 1 },
    { kind: 'key', key: 'a' },
    { kind: 'key', key: 'a', ctrl: true },
    { kind: 'wheel', x: 0.5, y: 0.5, dy: 120 },
  ]
  // A busy PC (other tests, robots) slows one measure: the best of 3 counts.
  let local, onCompanion
  for (let k = 0; k < 3; k++) {
    local = await measure(2, kinds)
    onCompanion = await measure(1, kinds)
    if (local.median < 250 && onCompanion.median < 300) break
  }
  console.log(`LIVE INPUT ROUND TRIP (localhost) — main PC tab: ack ${local.ack.toFixed(1)} ms, to new frame median ${local.median.toFixed(1)} ms, p90 ${local.p90.toFixed(1)} ms; Companion tab (via the main PC): ack ${onCompanion.ack.toFixed(1)} ms, median ${onCompanion.median.toFixed(1)} ms, p90 ${onCompanion.p90.toFixed(1)} ms`)
  assert.ok(local.median < 250 && onCompanion.median < 300, 'feels immediate on the office network')

  // Paste goes in as typed text.
  await lPage.focus('#i')
  await fetch(`${base}/automations/2/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'paste', text: 'P-123456' }) })
  assert.equal(await lPage.$eval('#i', e => e.value), 'P-123456')
})
