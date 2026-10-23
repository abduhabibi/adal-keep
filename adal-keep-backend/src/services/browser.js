/**
 * browser.js
 *
 * Single persistent Chromium instance shared across all automation lanes.
 * Never spawns more than one browser process.
 *
 * Layout: ONE maximized browser window — the Adal Keep page and one tab
 * per run. All runs share the browser's default context (one sign-in for
 * LMIS / Musaned). No extra windows, no separate processes per run.
 *
 * Cross-platform: Windows / macOS / Linux.
 *
 * v2 — Anti-throttle flags added so background lane tabs keep their
 *      timers, renderer priority, and rAF loop fully active while the
 *      user is focused on a different tab/window:
 *        --disable-background-timer-throttling
 *        --disable-renderer-backgrounding
 *        --disable-backgrounding-occluded-windows
 *      Without these, Chrome clamps setTimeout/setInterval to 1/min and
 *      starves the LMIS page's React state machine in non-focused lanes.
 *
 * v3 — Removed `--blink-settings=imagesEnabled=false`. That flag is
 *      browser-wide and can't be overridden per-tab, which made the
 *      Musaned reCAPTCHA image challenges render as empty white squares.
 *      Image policy is now decided per-job in worker.js via the dynamic
 *      `page.__adalAllowImages` flag inside the request interceptor.
 */

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

let _browser = null

/**
 * Find a Chromium-based browser executable on this machine.
 * Returns the first one that exists, or null.
 */
function findBrowserExecutable() {
  const candidates = []

  if (process.platform === 'win32') {
    const pf   = process.env['ProgramFiles']      || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const la   = process.env['LOCALAPPDATA']
              || path.join(process.env.USERPROFILE || 'C:\\Users\\Public', 'AppData', 'Local')
    candidates.push(
      path.join(pf,   'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(la,   'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(pf,   'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(la,   'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf,   'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    )
  } else {
    candidates.push(
      '/usr/bin/brave-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    )
  }

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return null
}

// One browser profile for Adal Keep, kept between restarts (LMIS and Musaned
// stay signed in). The launcher opens the Adal Keep page with this same
// profile, so the page and every run are tabs of ONE window.
export const PROFILE_DIR = process.env.ADAL_BROWSER_PROFILE ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'browser-profile')
const DEBUG_PORT = 9222

const BROWSER_ARGS = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-crash-restore-bubble',
  '--start-maximized',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  // NOTE: do NOT add '--blink-settings=imagesEnabled=false': it is
  // browser-wide and blanks the Musaned reCAPTCHA images. Image policy is
  // per tab (`page.__adalAllowImages`, see tabManager.setupTab).
  '--disable-notifications',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--disable-popup-blocking',
  '--noerrdialogs',
  '--disable-infobars',
  // Keep background run tabs fully active: without these Chrome slows the
  // timers of tabs that are not in front to ~1 tick a minute.
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
]

async function connectTo(puppeteer, url) {
  const b = await puppeteer.connect({ browserURL: url, defaultViewport: null })
  b.on('disconnected', () => {
    console.log('[browser] disconnected')
    if (_browser === b) _browser = null
  })
  return b
}

/**
 * Get the shared browser. Connects to the Adal Keep browser when it is
 * already open (the launcher may have opened it); otherwise starts it, with
 * the Adal Keep page as its first tab. Runs then open tabs in that window —
 * never a new window. The browser is not closed when the server stops.
 */
export async function getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) {
    return _browser
  }

  const puppeteer = (await import('puppeteer-core')).default
  const cdpUrl = process.env.BRAVE_CDP_URL || `http://localhost:${DEBUG_PORT}`
  try {
    _browser = await connectTo(puppeteer, cdpUrl)
    console.log('[browser] connected to the open browser at', cdpUrl)
    return _browser
  } catch {
    // not open yet — start it
  }

  const exec = findBrowserExecutable()
  if (!exec) {
    throw new Error(
      'No Chromium-based browser found. Install Brave, Chrome, or Edge, ' +
      'or set BRAVE_CDP_URL to an already-running instance with --remote-debugging-port=9222'
    )
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  const ui = `http://localhost:${process.env.PORT || 4000}`
  const child = spawn(exec, [...BROWSER_ARGS, ui], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  console.log('[browser] started', exec, 'profile', PROFILE_DIR)

  const deadline = Date.now() + 30000
  let lastErr = null
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    try {
      _browser = await connectTo(puppeteer, cdpUrl)
      return _browser
    } catch (e) { lastErr = e }
  }
  throw new Error(`The browser did not open its control port (${lastErr?.message || 'timeout'}). ` +
    'If Brave was already open with the Adal Keep profile, close it and try again.')
}

/**
 * The Adal Keep browser when it is open — never starts it. For watchers
 * that only act on tabs a person or a run already opened.
 */
export async function openBrowserIfAny() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser
  try {
    const puppeteer = (await import('puppeteer-core')).default
    _browser = await connectTo(puppeteer, process.env.BRAVE_CDP_URL || `http://localhost:${DEBUG_PORT}`)
    return _browser
  } catch { return null }
}

/**
 * Close everything cleanly. Call on process shutdown.
 */
export async function closeBrowser() {
  // Let go of the browser without closing it: the person's tabs stay open.
  if (_browser) {
    try { await _browser.disconnect() } catch {}
    _browser = null
    console.log('[browser] released')
  }
}