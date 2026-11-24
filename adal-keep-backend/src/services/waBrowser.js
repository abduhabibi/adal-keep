/**
 * The hidden WhatsApp browser, kept across a server restart (2026-11-24).
 *
 * Before, puppeteer started it as the server's own child: every restart of
 * Adal Keep (an update, a restart of the service) closed it and a new one
 * loaded WhatsApp from the start — CPU and a minute of "starting" each time,
 * and on this PC a new browser every couple of minutes while updates landed.
 * Now Adal Keep starts it by itself (headless, never a window) and only talks
 * to it; after a restart it finds it again by the port the browser writes in
 * its own profile (DevToolsActivePort) and goes on in it: one browser.
 *
 * And when it keeps dying, it is started again later and later (backoffMs),
 * never in a loop.
 */
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

/** The browser already running on this profile: its DevTools address, else null. */
export async function liveEndpoint(dir, { timeoutMs = 2000 } = {}) {
  let port, id
  try { [port, id] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n').map(x => x.trim()); port = Number(port) } catch { return null }
  if (!port || !/^\/devtools\/browser\/[\w-]+$/.test(id || '')) return null
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    const ws = (await r.json())?.webSocketDebuggerUrl
    // The same browser that wrote the file (its id), never another one that took the port later.
    return typeof ws === 'string' && ws === `ws://127.0.0.1:${port}${id}` ? ws : null
  } catch { return null }
}

/**
 * Starts the browser on its own (not a child that dies with the server) and
 * answers its DevTools address once it is up.
 */
export async function launchKept({ exe, dir, args = [], waitMs = 30000, spawnFn = spawn }) {
  fs.mkdirSync(dir, { recursive: true })
  fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true })
  const child = spawnFn(exe, [
    `--user-data-dir=${dir}`, '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--hide-scrollbars', '--password-store=basic', '--use-mock-keychain', ...args, 'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  let exited = null
  child.once?.('exit', (code) => { exited = code ?? 'signal' })
  child.once?.('error', (e) => { exited = e.message })
  child.unref?.()
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    if (exited !== null) throw new Error(`the browser stopped as it started (${exited})`)
    const ws = await liveEndpoint(dir, { timeoutMs: 1000 })
    if (ws) return ws
    await new Promise(r => setTimeout(r, 250))
  }
  try { process.kill(child.pid) } catch {}
  throw new Error(`the browser did not start within ${Math.round(waitMs / 1000)} s`)
}

/**
 * How long to wait before starting it again, from when it died before:
 * the first time in 10 minutes 3 s, then 30 s, 2 min, 5 min (at most).
 */
export function backoffMs(deaths = [], now = Date.now()) {
  const recent = deaths.filter(t => now - t < 10 * 60_000).length
  return [3_000, 30_000, 120_000][recent - 1] ?? (recent ? 300_000 : 3_000)
}
