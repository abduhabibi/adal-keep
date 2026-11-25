// The Scan button's PC side, with a fake scanner (no real Canon here): every message, one at a time,
// the temporary file removed, the picture handed over once, the off switch.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import express from 'express'
import http from 'http'
import sharp from 'sharp'
import { makeScanner, messageFor, script } from '../src/services/scanner.js'

const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#88a' } }).png().toBuffer()
const outOf = (ps) => ps.match(/SaveFile\('([^']+)'\)/)?.[1]
const list = (devices) => async () => ({ stdout: `@@${JSON.stringify({ ok: true, devices })}\n` })
/** A fake WIA: `onScan(ps)` decides what the scan does. */
const fake = (devices, onScan) => async (ps, o) => ps.includes('DeviceInfos') && !ps.includes('Transfer') ? (await list(devices)()) : onScan(ps, o)
const canon = [{ id: '{CANON}', name: 'Canon G3030 series' }]
const done = async (s, id) => { for (let i = 0; i < 100; i++) { const st = s.scanStatus(id); if (st.state !== 'scanning') return st; await new Promise(r => setTimeout(r, 10)) } throw new Error('never done') }
const ok = (ps) => { fs.writeFileSync(outOf(ps), png); return { stdout: '@@{"ok":true}\n' } }
const fail = (code) => async () => ({ stdout: `@@${JSON.stringify({ ok: false, code, text: 'x' })}\n` })

test('which scanner will be used is said, and why there is none', async () => {
  const s = makeScanner({ platform: 'win32', host: 'DESKTOP-1ACAO6S', run: fake(canon, ok) })
  const st = await s.status()
  assert.equal(st.code, 'ready'); assert.equal(st.scanner.name, 'Canon G3030 series'); assert.match(st.message, /Canon G3030 series on DESKTOP-1ACAO6S/)
  assert.equal((await makeScanner({ platform: 'win32', run: fake([], ok), printers: async () => [] }).status()).code, 'no-scanner')
  const d = await makeScanner({ platform: 'win32', run: fake([], ok), printers: async () => ['EPSON L3110 Series'] }).status()
  assert.equal(d.code, 'driver-missing'); assert.match(d.message, /Epson Scan 2/)
  assert.equal((await makeScanner({ platform: 'linux' }).status()).code, 'no-scanner')
})

test('a good scan: a JPEG in memory, handed over once, the temporary file gone', async () => {
  let tmp
  const s = makeScanner({ platform: 'win32', run: fake(canon, (ps) => { tmp = outOf(ps); return ok(ps) }) })
  const r = s.start({ dpi: 300 })
  assert.ok(r.id)
  assert.equal((await done(s, r.id)).state, 'done')
  assert.equal(fs.existsSync(tmp), false)
  const jpeg = s.take(r.id)
  assert.equal((await sharp(jpeg).metadata()).format, 'jpeg')
  assert.equal(s.take(r.id), null)   // once
  assert.ok(tmp.startsWith(os.tmpdir()))
})

test('one scan at a time: the second is told "busy"', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const s = makeScanner({ platform: 'win32', run: fake(canon, async (ps) => { await gate; return ok(ps) }) })
  const a = s.start({})
  const b = s.start({})
  assert.equal(b.error.code, 'busy')
  release(); await done(s, a.id)
  assert.ok(s.start({}).id)   // free again
})

test('each trouble has its own plain message', async () => {
  for (const [hex, code, re] of [['80210005', 'off', /off or not connected/], ['80210016', 'cover-open', /cover is open/], ['80210015', 'no-scanner', /No scanner/], ['80210003', 'paper', /no paper/], ['80210006', 'device-busy', /busy/]]) {
    const s = makeScanner({ platform: 'win32', run: fake(canon, fail(hex)) })
    const st = await done(s, s.start({}).id)
    assert.equal(st.error.code, code, hex); assert.match(st.error.message, re)
  }
  const odd = makeScanner({ platform: 'win32', run: fake(canon, fail('8021FFFF')) })
  assert.equal((await done(odd, odd.start({}).id)).error.code, 'failed')
  assert.equal(messageFor('0x80210016')[0], 'cover-open')
})

test('cancelled by the person, and stopped after the time limit', async () => {
  let killed = false
  const s = makeScanner({ platform: 'win32', run: fake(canon, (ps, o) => new Promise((res, rej) => { o.onChild({ kill: () => { killed = true; rej(Object.assign(new Error('stopped'), { killed: true })) } }) })) })
  const r = s.start({})
  await new Promise(r => setTimeout(r, 20))
  assert.equal(s.cancel(), true); assert.equal(killed, true)
  const st = await done(s, r.id)
  assert.equal(st.error.code, 'cancelled')
  assert.equal(s.cancel(), false)
  const t = makeScanner({ platform: 'win32', run: fake(canon, async () => { throw Object.assign(new Error('stopped'), { killed: true }) }) })
  const e = (await done(t, t.start({}).id)).error
  assert.equal(e.code, 'timeout'); assert.match(e.message, /2 minutes/)
})

test('the off switch ADAL_SCAN=0 turns it all off; the script keeps to WIA and a hidden window', async () => {
  process.env.ADAL_SCAN = '0'
  try {
    const s = makeScanner({ platform: 'win32', run: fake(canon, ok) })
    assert.equal((await s.status()).enabled, false)
    assert.equal(s.start({}).error.code, 'off-switch')
  } finally { delete process.env.ADAL_SCAN }
  const ps = script({ action: 'scan', id: "x'y", dpi: 300, out: "C:\\t\\a'b.png" })
  assert.match(ps, /WIA\.DeviceManager/); assert.ok(ps.includes("x''y")); assert.ok(ps.includes("a''b.png"))
  assert.doesNotMatch(ps, /Invoke-WebRequest|DownloadFile|Start-Process/)
})

test('the routes: start → status → image, over HTTP', async () => {
  const { default: router, scanner } = await import('../src/routes/scan.js')
  const app = express(); app.use(express.json()); app.use('/api', router)
  const server = http.createServer(app).listen(0)
  const base = `http://127.0.0.1:${server.address().port}/api/scan`
  try {
    const st = await (await fetch(`${base}/status`)).json()
    assert.ok(['no-scanner', 'ready'].includes(st.code))   // this Linux PC: no scanner, said plainly
    const r = await fetch(`${base}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"dpi":300}' })
    assert.equal(r.status, 400); assert.equal((await r.json()).code, 'no-scanner')
    assert.equal((await fetch(`${base}/nothing`)).status, 404)
    assert.equal((await fetch(`${base}/nothing/image`)).status, 404)
  } finally { server.close() }
})
