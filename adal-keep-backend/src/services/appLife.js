/**
 * appLife.js — Adal Keep lives as long as its window on this PC.
 *
 * It never works without its window (2026-11-16): started with no Adal Keep page
 * open within 90 s — by Windows at sign-in, an update, a restart — it ends.
 * Once a window has been open on this PC and the last one is closed — its X, or
 * Adal Keep closed — everything ends after a short wait: the launcher (which
 * would start the server again), the Companion and the agent, the agents' and
 * WhatsApp's browsers, and this server. The icon starts it all again.
 *
 * Each window on this PC keeps one stream open (GET /api/app/alive); a page that
 * reloads is back well within the wait. Windows on other computers and phones
 * do not count: they cannot end the main PC.
 */
import { execFile } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

export const GRACE_MS = 20_000
const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const open = new Set()
let seen = false, timer = null, ending = false

/** What a window may want to know before it closes: is something still working? */
export async function busyNow() {
  let runs = 0, moving = false
  try { runs = (await import('./busy.js')).runsWorking() } catch {}
  try { moving = (await import('./transition.js')).transitionRunning() } catch {}
  return { runs, moving, busy: runs > 0 || moving }
}

/** A window on this PC opened its stream; `gone` is called when it closes. */
export function windowOpened(stream, { grace = GRACE_MS, end = endEverything } = {}) {
  open.add(stream)
  seen = true
  clearTimeout(timer)
  timer = null
  return function gone() {
    open.delete(stream)
    if (open.size || ending) return
    clearTimeout(timer)
    timer = setTimeout(() => { if (!open.size && seen) end('the last Adal Keep window was closed') }, grace)
  }
}

export const windowsOpen = () => open.size

/** Ends Adal Keep on this PC: never the person's own browser, only Adal Keep's. */
export async function endEverything(why) {
  if (ending) return
  ending = true
  console.log(`[app] ${why} — Adal Keep stops everything`)
  if (process.platform === 'win32') {
    // 1. The launcher first, or it starts the server again (2026-11-15 it did:
    //    the list of processes took too long right after start-up). It is this
    //    server's own parent: stopped by its number at once, then checked.
    for (let i = 0; i < 3; i++) {
      const left = await launchers()
      if (!left.length) break
      await new Promise(done => execFile('taskkill.exe', ['/F', ...left.flatMap(p => ['/PID', String(p)])], { windowsHide: true, timeout: 15_000 }, () => done()))
      await new Promise(r => setTimeout(r, 400))
    }
    // 2. The Companion, the agent and Adal Keep's own browsers (never the person's).
    await new Promise(done => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', closeScript(process.pid)], { windowsHide: true, timeout: 60_000 }, () => done()))
    // 3. The launcher once more (in case one came back meanwhile).
    const still = await launchers()
    if (still.length) await new Promise(done => execFile('taskkill.exe', ['/F', ...still.flatMap(p => ['/PID', String(p)])], { windowsHide: true, timeout: 15_000 }, () => done()))
  }
  try { (await import('./browser.js')).closeBrowser?.() } catch {}
  setTimeout(() => process.exit(0), 500)
}

/** This install's launchers (AdalKeep.exe) still running: their process numbers. */
async function launchers() {
  const ids = new Set()
  // The parent of this server, when it is AdalKeep.exe (no process list needed).
  const parent = await new Promise(done => execFile('tasklist.exe', ['/FI', `PID eq ${process.ppid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15_000 }, (e, out) => done(e ? '' : String(out))))
  if (/^"AdalKeep\.exe"/im.test(parent)) ids.add(process.ppid)
  // Any other AdalKeep.exe (started at sign-in, or a second copy).
  const all = await new Promise(done => execFile('tasklist.exe', ['/FI', 'IMAGENAME eq AdalKeep.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15_000 }, (e, out) => done(e ? '' : String(out))))
  for (const m of all.matchAll(/^"AdalKeep\.exe","(\d+)"/gim)) ids.add(Number(m[1]))
  return [...ids]
}

/** The PowerShell that stops the Companion, the agent and Adal Keep's own browsers (tests read it). */
export function closeScript(me) {
  const data = path.join(INSTALL, 'backend', 'data').toLowerCase().replace(/'/g, "''")
  const root = INSTALL.toLowerCase().replace(/'/g, "''")
  return [
    `$me = ${Number(me)}`,
    `$all = Get-CimInstance Win32_Process`,
    `$ours = $all | Where-Object { $_.ProcessId -ne $me -and (`,
    `  ($_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith('${root}\\') -and $_.Name -match '^(AdalKeep|adal-companion|adal-agent|AdalBrowser)\\.exe$') -or`,
    `  ($_.Name -match '^(chrome|msedge|brave)\\.exe$' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains('${data}')) ) }`,
    `foreach ($n in 'AdalKeep.exe','adal-companion.exe','adal-agent.exe') { $ours | Where-Object { $_.Name -eq $n } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
    `$ours | Where-Object { $_.Name -notmatch '^(AdalKeep|adal-companion|adal-agent)\\.exe$' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ].join('\n')
}

/**
 * Adal Keep never works without its window (asked on 2026-11-14 and again
 * 2026-11-16: "if I click X then never open by itself at all"). Whatever
 * started this server — Windows at sign-in, a launcher that survived a close,
 * an update or a restart — when no Adal Keep page is open within 90 s,
 * everything ends. Unless "open Adal Keep when the PC starts" is on.
 */
export async function endIfStartedAlone({ waitMs = 90_000, end = endEverything } = {}) {
  if (process.platform !== 'win32') return false
  try {
    const fs = await import('fs')
    const startFile = path.join(INSTALL, 'backend', 'data', 'open-at-start.json')
    if (/"on"\s*:\s*true/.test(fs.readFileSync(startFile, 'utf8'))) return false
  } catch {}
  console.log(`[app] started: it ends in ${Math.round(waitMs / 1000)} s unless an Adal Keep page is open`)
  setTimeout(() => { if (!seen && !open.size) end('no Adal Keep page was opened after it started (it never works in the background)') }, waitMs).unref?.()
  return true
}

/** Tests only. */
export function _reset() { open.clear(); seen = false; ending = false; clearTimeout(timer); timer = null }
export const _launchers = () => launchers()
