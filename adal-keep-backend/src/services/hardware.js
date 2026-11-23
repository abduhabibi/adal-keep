/**
 * hardware.js — what this PC is made of: processor cores, RAM, 32/64-bit and
 * the network link. Weak agency PCs (2-core AMD A4, 7 GB) were swamped by
 * robots, so below 4 cores / 8 GB the app warns, and — with ADAL_HW_GATE=1 —
 * the robot worker never runs on a PC under 4 cores (the run waits for a
 * stronger PC of the office, services/sharePower.js hands it over).
 * The numbers go out in the heartbeat (cloudSync beatData, key `hw`).
 */
import os from 'os'

export const MIN_CORES = 4
export const MIN_RAM_GB = 8
// An "8 GB" PC reports about 7.4 GB (the graphics chip keeps some): below 7 is below 8.
const RAM_SLACK_GB = 7
const GB = 1024 ** 3

/** 'good' | 'slow' | 'unreliable' | 'unknown' from netQuality's { rtt_ms, mbps, ok }. */
export function linkOf(net) {
  if (!net) return 'unknown'
  if (net.ok != null && net.ok < 0.7) return 'unreliable'
  if ((net.rtt_ms != null && net.rtt_ms > 600) || (net.mbps != null && net.mbps < 2)) return 'slow'
  return 'good'
}

/** The 32/64-bit of the PC (a 32-bit Node on 64-bit Windows still says 64: PROCESSOR_ARCHITEW6432). */
export function bitsOf(arch = process.arch, env = process.env) {
  if (env.PROCESSOR_ARCHITEW6432) return 64
  return ['x64', 'arm64', 'ppc64', 's390x', 'riscv64', 'loong64', 'mips64el'].includes(arch) ? 64 : 32
}

/** The PC measured: { cores, mem_gb, bits, arch, link, net, weak, reasons[] } (inputs only for the tests). */
export function measure({ cores = os.cpus()?.length || 1, totalmem = os.totalmem(), arch = process.arch, env = process.env, net = null } = {}) {
  const mem_gb = Math.round((totalmem / GB) * 10) / 10
  const reasons = []
  if (cores < MIN_CORES) reasons.push(`${cores} processor core${cores === 1 ? '' : 's'} (needs ${MIN_CORES})`)
  if (mem_gb < RAM_SLACK_GB) reasons.push(`${mem_gb} GB of memory (needs ${MIN_RAM_GB})`)
  const bits = bitsOf(arch, env)
  if (bits === 32) reasons.push('32-bit Windows (needs 64-bit)')
  const link = linkOf(net)
  if (link === 'slow' || link === 'unreliable') reasons.push(`the internet link is ${link}`)
  return { cores, mem_gb, bits, arch, link, net, weak: cores < MIN_CORES || mem_gb < RAM_SLACK_GB || bits === 32, reasons }
}

let ownNetFn = null
import('./netQuality.js').then(n => { ownNetFn = n.ownNet }).catch(() => {})
export const hardwareNow = () => measure({ net: ownNetFn ? ownNetFn() : null })

/** The robot worker's rule: never on a PC under 4 cores (ADAL_HW_GATE=1 turns it on). */
export const robotsBlocked = (hw = hardwareNow(), env = process.env) => env.ADAL_HW_GATE === '1' && hw.cores < MIN_CORES

/** The short form in the heartbeat. */
export const hardwareBeat = () => { const h = hardwareNow(); return { cores: h.cores, mem_gb: h.mem_gb, bits: h.bits, link: h.link, weak: h.weak } }
