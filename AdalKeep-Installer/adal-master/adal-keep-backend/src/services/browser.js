/**
 * browser.js
 *
 * Single persistent Chromium instance shared across all automation lanes.
 * Never spawns more than one browser process.
 *
 * Layout: one maximized browser window, one tab per job.
 * All jobs share the browser's DEFAULT context so they share the same
 * LMIS session — no off-screen windows, no separate processes per lane.
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

/**
 * Get (or lazily create) the shared browser instance.
 * Idempotent — calling this 100 times returns the same browser.
 */
export async function getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) {
    return _browser
  }

  const puppeteer = (await import('puppeteer-core')).default

  // Prefer connecting to an already-running browser with a debugging port
  // (useful during development: you can watch what's happening).
  const cdpUrl = process.env.BRAVE_CDP_URL || 'http://localhost:9222'
  try {
    _browser = await puppeteer.connect({
      browserURL: cdpUrl,
      defaultViewport: null,
    })
    console.log('[browser] connected to existing browser at', cdpUrl)
    return _browser
  } catch {
    // no debugging port available — launch a fresh one
  }

  const exec = findBrowserExecutable()
  if (!exec) {
    throw new Error(
      'No Chromium-based browser found. Install Brave, Chrome, or Edge, ' +
      'or set BRAVE_CDP_URL to an already-running instance with --remote-debugging-port=9222'
    )
  }

  _browser = await puppeteer.launch({
    executablePath: exec,
    headless: false,          // show the browser so a human can verify
    defaultViewport: null,
    args: [
      '--remote-debugging-port=9222',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      // NOTE: do NOT re-add '--blink-settings=imagesEnabled=false' here.
      // That flag is browser-wide and cannot be overridden per tab, so it
      // makes the Musaned reCAPTCHA image challenges render as empty
      // white squares. Image policy is now per-job, decided in worker.js
      // via `page.__adalAllowImages` inside the request interceptor.
      '--mute-audio',
      '--disable-notifications',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--disable-popup-blocking',
      '--noerrdialogs',
      '--disable-infobars',
      '--window-position=-2400,-2400',

      // --- Anti-throttle: keep background lane tabs fully active -----------
      // Without these, Chrome clamps timers in background/occluded tabs to
      // ~1 tick/minute, which stalls React state machines and long-running
      // page scripts (e.g. the LMIS placed-labors flow) in non-focused lanes.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  })
  console.log('[browser] launched fresh browser:', exec)

  _browser.on('disconnected', () => {
    console.log('[browser] disconnected')
    _browser = null
  })

  return _browser
}

/**
 * Close everything cleanly. Call on process shutdown.
 */
export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close() } catch {}
    _browser = null
    console.log('[browser] closed')
  }
}