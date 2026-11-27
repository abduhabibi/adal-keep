/** pcCheck.test.js — the equipment check: Main / Companion rules, the fixes, the USB Wi-Fi stick, the off switch (2026-11-27). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { checkList, pcCheck, pcCheckReport, RULES, _reset } from '../src/services/pcCheck.js'

const good = { ram_gb: 15.8, cores: 8, disk: { media: 'SSD', free_gb: 120 }, net: { kind: 'cable', mbps: 1000, usb: false, free_ports: 0 } }
const by = (items) => Object.fromEntries(items.map(i => [i.key, i]))

test('a good Main PC: all OK', () => {
  const l = checkList(good, 'main')
  assert.deepEqual(l.map(i => i.key), ['ram', 'disk', 'free', 'cores', 'net'])
  assert.ok(l.every(i => i.state === 'ok'), JSON.stringify(l))
  assert.equal(by(l).net.text, 'Network: cable 1000 Mbit/s')
})

test("today's Main: A4 2 cores, 7.4 GB, hard disk, a USB-1.1 Wi-Fi stick at 4 Mbit/s, the gigabit port empty", () => {
  const l = by(checkList({ ram_gb: 7.4, cores: 2, disk: { media: 'HDD', free_gb: 12 }, net: { kind: 'wifi', mbps: 4, usb: true, free_ports: 1 } }, 'main'))
  assert.equal(l.ram.state, 'ok')   // an "8 GB" PC reports ~7.4
  assert.equal(l.disk.state, 'weak'); assert.equal(l.disk.fix, 'Replace the disk with an SSD')
  assert.equal(l.free.state, 'weak'); assert.match(l.free.text, /12 GB \(needs 20 GB\)/)
  assert.equal(l.cores.state, 'weak')
  assert.equal(l.net.state, 'weak')
  assert.match(l.net.text, /slow USB Wi-Fi stick, 4 Mbit\/s/)
  assert.equal(l.net.fix, 'Plug a network cable into the port at the back')
})

test('Main on a fast Wi-Fi: still weak (a cable), no free port → a USB network adapter', () => {
  const l = by(checkList({ ...good, net: { kind: 'wifi', mbps: 300, usb: false, free_ports: 0 } }, 'main'))
  assert.equal(l.net.state, 'weak')
  assert.equal(l.net.text, 'Network: Wi-Fi 300 Mbit/s, not a cable')
  assert.match(l.net.fix, /no free network port/)
})

test('little RAM: Add RAM', () => {
  const l = by(checkList({ ...good, ram_gb: 3.9 }, 'main'))
  assert.equal(l.ram.state, 'weak'); assert.equal(l.ram.fix, 'Add RAM (to 8 GB or more)')
})

test('a Companion: 4 GB is enough, Wi-Fi fine, a hard disk only a tip, no free-disk or cores lines; a slow stick still weak', () => {
  const l = by(checkList({ ram_gb: 3.7, cores: 2, disk: { media: 'HDD', free_gb: 5 }, net: { kind: 'wifi', mbps: 72, usb: false } }, 'companion'))
  assert.deepEqual(Object.keys(l), ['ram', 'disk', 'net'])
  assert.equal(l.ram.state, 'ok'); assert.equal(l.disk.state, 'tip'); assert.equal(l.net.state, 'ok')
  assert.equal(by(checkList({ ram_gb: 2, cores: 2, disk: { media: 'SSD' }, net: { kind: 'wifi', mbps: 5, usb: true } }, 'companion')).net.state, 'weak')
  assert.equal(by(checkList({ ram_gb: 2, cores: 2, disk: { media: 'SSD' }, net: { kind: 'cable' } }, 'companion')).ram.fix, 'Add RAM (to 4 GB or more)')
})

test('nothing known: "could not tell", never weak by guess', () => {
  const l = by(checkList({ ram_gb: 16, cores: 4, disk: { media: 'unknown', free_gb: null }, net: { kind: 'cable', mbps: null } }, 'main'))
  assert.equal(l.disk.state, 'unknown'); assert.equal(l.free.state, 'unknown'); assert.equal(l.net.state, 'ok')
})

test('pc-check.ps1 has the same numbers as the server (installer and Settings say the same)', () => {
  const ps = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'pc-check.ps1'), 'utf8')
  assert.match(ps, new RegExp(`\\$main\\) \\{ ${RULES.main.ram_gb} \\} else \\{ ${RULES.companion.ram_gb} \\}`))
  assert.match(ps, new RegExp(`\\$main\\) \\{ ${RULES.main.ram_seen} \\} else \\{ ${RULES.companion.ram_seen} \\}`))
  assert.match(ps, new RegExp(`\\$free -ge ${RULES.main.free_gb}\\b`))
  assert.match(ps, new RegExp(`\\$cores -ge ${RULES.main.cores}\\b`))
  assert.match(ps, new RegExp(`\\$mbps -lt ${RULES.min_mbps}\\b`))
  for (const fix of ['Plug a network cable into the port at the back', 'Replace the disk with an SSD', 'Free some space: empty the Recycle Bin, delete old downloads']) assert.ok(ps.includes(fix), fix)
  assert.match(ps, /ADAL_PC_CHECK -eq '0'\) \{ exit 10 \}/)
  assert.ok(/^[\x00-\x7f]*$/.test(ps.replace(/^#.*$/gm, '')), 'the installer reads its list as plain ASCII')
})

test('this PC measured (Linux); the report short and without card names; off switch', async () => {
  _reset()
  const r = await pcCheck()
  assert.equal(r.on, true)
  assert.ok(r.items.length >= 3)
  const rep = pcCheckReport()
  assert.ok(JSON.stringify(rep).length < 400)
  assert.equal(rep.name, undefined)
  process.env.ADAL_PC_CHECK = '0'
  try { assert.deepEqual(await pcCheck({ fresh: true }), { on: false }); assert.equal(pcCheckReport(), null) } finally { delete process.env.ADAL_PC_CHECK }
})
