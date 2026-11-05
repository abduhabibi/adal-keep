/**
 * browser.js
 *
 * Single persistent Chromium instance shared across all automation lanes.
 * Never spawns more than one browser process.
 *
 * Adal Browser (<install>\\browser\\AdalBrowser.exe) is Adal Keep's own Chromium:
 * no Brave or Chrome is needed. The agents work in ONE window kept out of sight
 * (off the screen): a run that needs nobody is never seen, and nothing ever
 * pops up. A person brings a tab forward by pressing Open in the notification
 * (showTab); the window goes back when the run goes on (tuckAway). All runs
 * share one profile: one sign-in, and passwords saved in it stay.
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
export function findBrowserExecutable() {
  const candidates = [OWN_BROWSER]

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
// Adal Browser has a profile of its own: Chromium refuses a profile a newer
// browser wrote, and Brave's may be newer.
const OWN_BROWSER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'browser', 'AdalBrowser.exe')
export const PROFILE_DIR = process.env.ADAL_BROWSER_PROFILE ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', fs.existsSync(OWN_BROWSER) ? 'adal-browser' : 'browser-profile')
// Out of sight needs today's AdalKeep.exe: an older one opens Adal Keep's page
// inside this browser, and that page must stay on the screen.
const HIDDEN = process.platform !== 'win32' || process.env.ADAL_HIDDEN_AGENTS === '1'
const DEBUG_PORT = 9222
const OFF = { left: -32000, top: -32000, width: 1366, height: 900 }

/**
 * Start Brave fresh: one window, no tabs brought back from last time. Brave
 * is usually stopped without closing (the PC shut down, Adal Keep restarted),
 * so it thought it had crashed and reopened every old tab — slow (each old
 * portal page loads again) and a second window. Its last session is let go
 * (runs open their own tabs again anyway) and it starts on a new tab.
 */
function freshStart() {
  try {
    const prefs = path.join(PROFILE_DIR, 'Default', 'Preferences')
    if (fs.existsSync(prefs)) {
      const p = JSON.parse(fs.readFileSync(prefs, 'utf8'))
      p.profile = { ...(p.profile || {}), exit_type: 'Normal', exited_cleanly: true }
      p.session = { ...(p.session || {}), restore_on_startup: 5 }
      fs.writeFileSync(prefs, JSON.stringify(p))
    }
    const sessions = path.join(PROFILE_DIR, 'Default', 'Sessions')
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) fs.rmSync(path.join(sessions, f), { force: true })
  } catch (e) { console.warn('[browser] fresh start:', e.message) }
}

const BROWSER_ARGS = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-crash-restore-bubble',
  // Out of sight from its first moment.
  ...(HIDDEN ? [`--window-position=${OFF.left},${OFF.top}`, `--window-size=${OFF.width},${OFF.height}`] : ['--start-maximized']),
  // Windows / Mac: drawing pages on the graphics chip leaves the processor
  // free (low-end PCs slowed down with everything drawn by the processor).
  ...(process.platform === 'linux' ? ['--disable-gpu'] : []),
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  // NOTE: do NOT add '--blink-settings=imagesEnabled=false': it is
  // browser-wide and blanks the Musaned reCAPTCHA images. Image policy is
  // per tab (`page.__adalAllowImages`, see tabManager.setupTab).
  '--disable-notifications',
  '--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
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
      'Adal Browser is not on this PC yet: it is getting ready, try again in a minute.'
    )
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  freshStart()
  // No page of its own: with Brave already open on this profile (without the
  // control port) a start only adds a tab to that window — it used to be an
  // Adal Keep tab every time a run or watcher looked for the browser.
  const child = spawn(exec, BROWSER_ARGS, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  console.log('[browser] started', exec, 'profile', PROFILE_DIR)

  const deadline = Date.now() + 30000
  let lastErr = null
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    try {
      _browser = await connectTo(puppeteer, cdpUrl)
      // Just started: Brave restores its last tabs and replaces its first
      // blank one — a run's tab opened in that moment is closed under it.
      await new Promise(r => setTimeout(r, 3000))
      await tuckAway({ force: true }).catch(() => {})
      return _browser
    } catch (e) { lastErr = e }
  }
  throw new Error('The browser is open without Adal Keep\'s control (it was opened by hand). Close every browser window, then press the button again — Adal Keep opens it itself.')
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

async function windowOf(page) {
  const cdp = page.__adalCdp || await page.target().createCDPSession()
  const { windowId } = await cdp.send('Browser.getWindowForTarget')
  return { cdp, windowId }
}
const place = async ({ cdp, windowId }, bounds) => {
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await cdp.send('Browser.setWindowBounds', { windowId, bounds })
}

let _held = false   // a person opened the browser to use it: it stays until they close it

/** The window comes forward on this tab: only ever because a person pressed Open. */
export async function showTab(page, { hold = false } = {}) {
  const w = await windowOf(page)
  await place(w, { left: 60, top: 40, width: 1280, height: 800 })
  await w.cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'maximized' } }).catch(() => {})
  await w.cdp.send('Page.bringToFront')
  _shown = true
  if (hold) _held = true
}
let _shown = false

/** The window goes back out of sight (nothing happens while a person uses it). */
export async function tuckAway({ force = false } = {}) {
  if (!HIDDEN || _held || (!force && !_shown)) return
  const browser = await openBrowserIfAny()
  const page = (await browser?.pages().catch(() => []))?.[0]
  if (!page) return
  await place(await windowOf(page), OFF)
  _shown = false
}

/** The browser for a person's own use: a new tab, in front, with its saved passwords. */
export async function openForPerson() {
  const browser = await getBrowser()
  const page = await browser.newPage()
  await showTab(page, { hold: true })
  page.once('close', () => { _held = false })
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