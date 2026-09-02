import puppeteer from 'puppeteer-core'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Persistent profile so Brave can save passwords / session
const USER_DATA = path.join(os.homedir(), '.adal-brave-profile')

let browser = null
let stopped = false
let status = 'idle'
let lastError = null

function findBrave() {
  const candidates = [
    process.env.BRAVE_PATH,
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/snap/bin/brave'
  ].filter(Boolean)
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  try {
    return execSync('which brave-browser 2>/dev/null || which brave 2>/dev/null', { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

export function getAgentStatus() {
  return { status, stopped, lastError, hasBrowser: !!browser }
}

/** Stop control only – never close Brave or tabs */
export async function stopAgent() {
  stopped = true
  status = 'stopped'
  try {
    if (browser) browser.disconnect()
  } catch {}
  browser = null
  return getAgentStatus()
}

async function ensureBrowser() {
  // Reuse in-memory browser
  if (browser && typeof browser.isConnected === 'function' && browser.isConnected()) {
    return browser
  }
  if (browser && browser.connected) {
    return browser
  }

  const userDataDir = process.env.BRAVE_USER_DATA || path.join(os.homedir(), '.adal-brave-profile')
  const debugPort = Number(process.env.BRAVE_DEBUG_PORT || 9222)

  // Try connect to already-running Brave with remote debugging
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${debugPort}`,
      defaultViewport: null
    })
    console.log('[Brave] Connected to existing browser on', debugPort)
    return browser
  } catch (_) {
    // not running with debug port — launch
  }

  const executablePath = findBrave()
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir,
      defaultViewport: null,
      args: [
        `--remote-debugging-port=${debugPort}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling'
      ]
    })
    console.log('[Brave] Launched with profile', userDataDir)
    browser.on('disconnected', () => { browser = null })
    return browser
  } catch (err) {
    // Profile locked by manual Brave — try connect again or clear message
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${debugPort}`,
        defaultViewport: null
      })
      console.log('[Brave] Connected after launch conflict')
      return browser
    } catch (e2) {
      const msg = err.message || String(err)
      if (/already running/i.test(msg)) {
        throw new Error(
          'Brave already open with Adal profile. Close that Brave window, or start it with remote debugging. Then retry.'
        )
      }
      throw err
    }
  }
}


async function getOrOpenTab(b, urlMatch, navigateTo) {
  const pages = await b.pages()
  // 1) Prefer exact / partial URL match
  for (const pg of pages) {
    try {
      const u = pg.url() || ''
      if (urlMatch.some(m => u.includes(m))) {
        await pg.bringToFront()
        return pg
      }
    } catch {}
  }
  // 2) Reuse about:blank instead of opening yet another tab
  for (const pg of pages) {
    try {
      const u = pg.url() || ''
      if (u === 'about:blank' || u === '' || u.startsWith('chrome://')) {
        if (navigateTo) {
          await pg.goto(navigateTo, { waitUntil: 'domcontentloaded', timeout: 60000 })
        }
        await pg.bringToFront()
        return pg
      }
    } catch {}
  }
  // 3) Only then create a new tab
  const pg = await b.newPage()
  if (navigateTo) {
    await pg.goto(navigateTo, { waitUntil: 'domcontentloaded', timeout: 60000 })
  }
  return pg
}

/**
 * Start / resume agent workspace.
 * - Opens Adal Keep if not already open
 * - Opens Pextran if not already open (Brave may autofill password)
 * - Does NOT type passwords from our DB
 * - Does NOT click Sign in
 */
export async function startAgent({ openPextran = false } = {}) {
  if (status === 'running' || status === 'starting') {
    return { ok: false, error: 'Agent already running', ...getAgentStatus() }
  }

  stopped = false
  status = 'starting'
  lastError = null

  try {
    const b = await ensureBrowser()
    if (stopped) {
      await stopAgent()
      return { ok: false, error: 'Stopped by user' }
    }

    await getOrOpenTab(b, ['localhost:3000', '127.0.0.1:3000'], 'http://localhost:3000/')

    if (stopped) {
      await stopAgent()
      return { ok: false, error: 'Stopped by user' }
    }

    if (openPextran) {
      await getOrOpenTab(
        b,
        ['pextran.com', 'zadulmead'],
        'https://zadulmead.agency.pextran.com'
      )
    }

    status = 'running'
    return {
      ok: true,
      message: 'Brave ready. Reused existing tabs when possible. Log in once so Brave saves the password.',
      ...getAgentStatus()
    }
  } catch (err) {
    lastError = err.message
    status = 'error'
    console.error('[BraveAgent]', err)
    try { if (browser) browser.disconnect() } catch {}
    browser = null
    return { ok: false, error: err.message, ...getAgentStatus() }
  }
}

export default { startAgent, stopAgent, getAgentStatus, ensureBrowser, getOrOpenTab }
