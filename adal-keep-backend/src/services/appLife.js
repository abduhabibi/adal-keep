/**
 * appLife.js — Adal Keep lives as long as its window on this PC.
 *
 * It starts with Windows (the launcher, --background) and works with no window.
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
    // The launcher first, or it would start the server again. Browsers only when
    // they run on Adal Keep's own profiles (its data folder) or are Adal Browser.
    const data = path.join(INSTALL, 'backend', 'data').toLowerCase().replace(/'/g, "''")
    const root = INSTALL.toLowerCase().replace(/'/g, "''")
    const ps = [
      `$me = ${process.pid}`,
      `$all = Get-CimInstance Win32_Process`,
      `$ours = $all | Where-Object { $_.ProcessId -ne $me -and (`,
      `  ($_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith('${root}\\') -and $_.Name -match '^(AdalKeep|adal-companion|adal-agent|AdalBrowser)\\.exe$') -or`,
      `  ($_.Name -match '^(chrome|msedge|brave)\\.exe$' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains('${data}')) ) }`,
      `foreach ($n in 'AdalKeep.exe','adal-companion.exe','adal-agent.exe') { $ours | Where-Object { $_.Name -eq $n } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
      `$ours | Where-Object { $_.Name -notmatch '^(AdalKeep|adal-companion|adal-agent)\\.exe$' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ].join('\n')
    await new Promise(done => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30_000 }, () => done()))
  }
  try { (await import('./browser.js')).closeBrowser?.() } catch {}
  setTimeout(() => process.exit(0), 500)
}

/**
 * Started by Windows at sign-in (the launcher, --background) with no window:
 * Adal Keep never works in the background (asked on 2026-11-14: "never make
 * Adal Keep open itself after I close it, never work in the background").
 * When no window opens within a minute, everything ends — unless someone
 * switched on "open Adal Keep when the PC starts" (then its window opens).
 * Older launchers on the PCs still start at sign-in; this ends them.
 */
export async function endIfStartedAlone({ waitMs = 60_000, end = endEverything } = {}) {
  if (process.platform !== 'win32') return false
  try {
    const fs = await import('fs')
    const startFile = path.join(INSTALL, 'backend', 'data', 'open-at-start.json')
    const openAtStart = /"on"\s*:\s*true/.test(fs.readFileSync(startFile, 'utf8'))
    if (openAtStart) return false
  } catch {}
  const root = INSTALL.toLowerCase().replace(/'/g, "''")
  const byWindows = await new Promise(done => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='AdalKeep.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith('${root}\\') -and $_.CommandLine -match '--background' }).Count`],
  { windowsHide: true, timeout: 30_000 }, (e, out) => done(!e && Number(String(out).trim()) > 0)))
  if (!byWindows) return false
  console.log(`[app] started by Windows at sign-in: it ends in ${Math.round(waitMs / 1000)} s unless its window is opened`)
  setTimeout(() => { if (!seen && !open.size) end('Windows started Adal Keep at sign-in and no window was opened (it does not work in the background)') }, waitMs).unref?.()
  return true
}

/** Tests only. */
export function _reset() { open.clear(); seen = false; ending = false; clearTimeout(timer); timer = null }
