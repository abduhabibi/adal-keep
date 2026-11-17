import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const WD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'watchdog.js')
const run = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-wd-'))
  const script = path.join(dir, 'a.mjs')
  fs.writeFileSync(script, `import { startWatchdog } from ${JSON.stringify('file:///' + WD.replace(/\\/g, '/'))}\nstartWatchdog(${JSON.stringify(dir)}, { freezeMs: 1500, beatMs: 100 })\n${body}`)
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [script], { timeout: 30_000 })
  return { r, ms: Date.now() - t0, note: fs.existsSync(path.join(dir, 'last-freeze.json')) }
}

test('a frozen server is ended within seconds and the freeze is noted', () => {
  const { r, ms, note } = run(`setTimeout(() => { const end = Date.now() + 20000; while (Date.now() < end) {} ; process.exit(0) }, 300)`)
  assert.notEqual(r.status, 0)
  assert.ok(ms < 15_000, `took ${ms} ms`)
  assert.equal(note, true)
})

test('a server that keeps answering is left alone', () => {
  const { r, note } = run(`setTimeout(() => process.exit(0), 4000)`)
  assert.equal(r.status, 0)
  assert.equal(note, false)
})
