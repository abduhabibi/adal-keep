/**
 * pcCheck.js — is this PC equipped well enough? (the owner, 2026-11-27) Settings → This PC shows a plain
 * check list: what is OK, what is weak and the fix. It warns, it never blocks anything.
 *
 *   Main PC:      8 GB RAM or more, an SSD, a network cable (not Wi-Fi), 20 GB free disk, 4 cores or more.
 *   Companion PC: 4 GB RAM or more, an SSD preferred.
 *   Both: a link under 20 Mbit/s is weak (Main's USB-1.1 Wi-Fi stick, ~4-5 Mbit/s, 2026-11-26).
 *
 * Windows: measured by pc-check.ps1 -Json (beside this file) (the installer runs the same script for its list; its rules
 * are the same as here — keep both). Elsewhere: from Node and /sys (development PCs).
 * Measured once at the first look, then at most every 10 minutes (a few seconds of PowerShell).
 * The tower gets the short form when PC reports are on (ADAL_PC_REPORTS=1, services/tower.js).
 * Off: ADAL_PC_CHECK=0.
 */
import os from 'os'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'

export const pcCheckOn = () => process.env.ADAL_PC_CHECK !== '0'
export const RULES = {
  main: { ram_gb: 8, ram_seen: 7, free_gb: 20, cores: 4 },
  companion: { ram_gb: 4, ram_seen: 3.5 },
  min_mbps: 20,
}

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pc-check.ps1')

function windowsFacts() {
  return new Promise((resolve) => {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const inst = path.resolve(process.cwd(), '..')
    execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Json', '-InstDir', inst],
      { timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => {
        try { resolve(JSON.parse(String(out).trim().split(/\r?\n/).pop())) } catch { resolve(null) }
      })
  })
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim() } catch { return null } }

/** Linux / Mac: the same facts from Node and /sys. */
export function otherFacts(dir = process.cwd()) {
  let free_gb = null
  try { const s = fs.statfsSync(dir); free_gb = Math.round((s.bavail * s.bsize) / 1024 ** 3 * 10) / 10 } catch {}
  // The disk: any non-removable block device spinning → a hard disk.
  let media = 'unknown'
  try {
    const disks = fs.readdirSync('/sys/block').filter(d => !/^(loop|ram|zram|dm-|sr)/.test(d) && read(`/sys/block/${d}/removable`) === '0')
    const rot = disks.map(d => read(`/sys/block/${d}/queue/rotational`))
    if (rot.length) media = rot.includes('1') ? 'HDD' : 'SSD'
  } catch {}
  let net = { kind: 'none', name: '', desc: '', mbps: null, usb: false, free_ports: 0 }
  try {
    const route = read('/proc/net/route')?.split('\n').slice(1).map(l => l.split(/\s+/)).find(c => c[1] === '00000000')
    const dev = route?.[0]
    if (dev) {
      const wifi = fs.existsSync(`/sys/class/net/${dev}/wireless`)
      const sp = Number(read(`/sys/class/net/${dev}/speed`))
      const usb = (fs.realpathSync(`/sys/class/net/${dev}/device`) || '').includes('/usb')
      net = { kind: wifi ? 'wifi' : 'cable', name: dev, desc: '', mbps: sp > 0 ? sp : null, usb, free_ports: 0 }
    }
    net.free_ports = fs.readdirSync('/sys/class/net').filter(d => d !== dev && !fs.existsSync(`/sys/class/net/${d}/wireless`) && fs.existsSync(`/sys/class/net/${d}/device`) && read(`/sys/class/net/${d}/carrier`) !== '1').length
  } catch {}
  return { ram_gb: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10, cores: os.cpus()?.length || 1, disk: { drive: dir, media, bus: '', free_gb }, net }
}

/** The check list: [{ key, state: 'ok' | 'weak' | 'tip' | 'unknown', text, fix? }] — the same rules as pc-check.ps1. */
export function checkList(f, role = 'main') {
  const main = role !== 'companion'
  const R = main ? RULES.main : RULES.companion
  const out = []
  const add = (key, state, text, fix) => out.push(fix ? { key, state, text, fix } : { key, state, text })
  if (f.ram_gb >= R.ram_seen) add('ram', 'ok', `Memory: ${f.ram_gb} GB`)
  else add('ram', 'weak', `Memory: ${f.ram_gb} GB (needs ${R.ram_gb} GB)`, `Add RAM (to ${R.ram_gb} GB or more)`)
  const d = f.disk || {}
  if (d.media === 'SSD') add('disk', 'ok', 'Disk: SSD')
  else if (d.media === 'HDD') {
    if (main) add('disk', 'weak', 'Disk: a hard disk, not an SSD', 'Replace the disk with an SSD')
    else add('disk', 'tip', 'Disk: a hard disk, not an SSD', 'An SSD makes this PC faster')
  } else add('disk', 'unknown', 'Disk: could not tell SSD or hard disk')
  if (main) {
    if (d.free_gb == null) add('free', 'unknown', 'Free disk: could not tell')
    else if (d.free_gb >= R.free_gb) add('free', 'ok', `Free disk: ${d.free_gb} GB`)
    else add('free', 'weak', `Free disk: ${d.free_gb} GB (needs ${R.free_gb} GB)`, 'Free some space: empty the Recycle Bin, delete old downloads')
    if (f.cores >= R.cores) add('cores', 'ok', `Processor: ${f.cores} cores`)
    else add('cores', 'weak', `Processor: ${f.cores} cores (needs ${R.cores})`, `Use a PC with ${R.cores} cores or more as the Main PC`)
  }
  const n = f.net || {}
  const speed = n.mbps != null ? ` ${n.mbps} Mbit/s` : ''
  const plug = n.free_ports > 0 ? 'Plug a network cable into the port at the back' : 'Add a network cable (this PC has no free network port: a USB network adapter)'
  if (n.kind === 'none' || !n.kind) add('net', 'weak', 'Network: no link', plug)
  else if (n.mbps != null && n.mbps < RULES.min_mbps) {
    const what = n.kind === 'wifi' ? (n.usb ? 'a slow USB Wi-Fi stick' : 'slow Wi-Fi') : 'a slow link'
    add('net', 'weak', `Network: ${what},${speed} (needs ${RULES.min_mbps} Mbit/s or more)`, plug)
  } else if (main && n.kind === 'wifi') add('net', 'weak', `Network: Wi-Fi${speed}, not a cable`, plug)
  else add('net', 'ok', `Network: ${n.kind === 'cable' ? 'cable' : n.kind === 'wifi' ? 'Wi-Fi' : 'connected'}${speed}`)
  return out
}

async function roleNow() {
  const M = await import('./mainPC.js').catch(() => ({}))
  try { return M.isCompanion?.() || M.notMainPC?.() ? 'companion' : 'main' } catch { return 'main' }
}

let last = null   // { at, facts, role, items }
let busy = null
const FRESH_MS = 10 * 60 * 1000

/** { on, role, at, weak, items } — measured now when the last is older than 10 minutes (or fresh). */
export async function pcCheck({ fresh = false } = {}) {
  if (!pcCheckOn()) return { on: false }
  if (!fresh && last && Date.now() - last.at < FRESH_MS) return view(last)
  if (!busy) busy = (async () => {
    try {
      const facts = process.platform === 'win32' ? await windowsFacts() : otherFacts()
      if (!facts) return last
      const role = await roleNow()
      last = { at: Date.now(), facts, role, items: checkList(facts, role) }
      return last
    } catch { return last } finally { busy = null }
  })()
  const r = await busy
  return r ? view(r) : { on: true, role: null, at: null, weak: null, items: [], why: 'This PC could not be measured.' }
}
const view = (r) => ({ on: true, role: r.role, at: new Date(r.at).toISOString(), weak: r.items.some(i => i.state === 'weak'), items: r.items, facts: r.facts })

/** The short form for the tower's report (no names of the PC's network cards). */
export function pcCheckReport() {
  if (!pcCheckOn() || !last) return null
  const f = last.facts
  return { at: new Date(last.at).toISOString(), role: last.role, ram_gb: f.ram_gb, cores: f.cores, disk: f.disk?.media, free_gb: f.disk?.free_gb,
    net: f.net?.kind, mbps: f.net?.mbps, usb: !!f.net?.usb, weak: last.items.filter(i => i.state === 'weak').map(i => i.key) }
}

export const _reset = () => { last = null }
