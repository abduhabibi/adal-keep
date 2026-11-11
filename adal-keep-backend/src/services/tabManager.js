/**
 * tabManager.js — every automation run owns exactly one browser tab.
 *
 * PROBLEM it solves
 * -----------------
 * Runs used to share tabs. A run adopted any tab already on its portal —
 * including a tab another run was still driving, or one the operator had
 * open — and the run id was written to localStorage, which every tab on the
 * same site shares. With two runs at once both ended up in one tab, and the
 * last one clicked took it over.
 *
 * WHAT THIS DOES
 * --------------
 *   openRunTab(browser, runId) → the run's own tab. A resumed run gets its tab
 *                                back; a new run takes a free tab already on
 *                                its site (signed in, no page load from
 *                                nothing) and goes to its page, else a new tab.
 *   tabOfRun(runId)            → that tab, or null.
 *   closeRunTab(runId)         → closes that tab and nothing else.
 *
 * A tab is only ever taken when nobody needs it (findFreeTab): never one that
 * a run owns, one waiting for a paused run, one a person is looking at, or a
 * person's half-filled form.
 *
 * All tabs live in the browser's shared default context, so cookies are
 * shared: a new tab on a portal the browser is logged into stays logged in.
 *
 * Cross-platform: pure Puppeteer/CDP — Windows / macOS / Linux identical.
 */
import { newRunTab, outOfSight } from './browser.js'

export const PEERS = {
  musaned: { hosts: ['tawtheeq.musaned.com.sa', 'accounts.wahid.sa'], label: 'Musaned' },
  lmis:    { hosts: ['lmis.gov.et'],                                  label: 'LMIS' },
  mofa:    { hosts: ['visa.mofa.gov.sa'],                             label: 'Visa platform' },
  insurance: { hosts: ['agency.niscofetap.com'],                        label: 'Insurance (FetaP)' },
  tasheer: { hosts: ['agents.tasheer.com'],                             label: 'Tasheer' },
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

export function isPeerUrl(url, peer) {
  const p = PEERS[peer]
  if (!p) return false
  const h = hostOf(url)
  if (!h) return false
  return p.hosts.some(x => h === x || h.endsWith('.' + x))
}

const TRACKERS = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net|facebook\.com|hotjar\.com|clarity\.ms|tiktok\.com|snapchat\.com|twitter\.com|linkedin\.com|youtube\.com)$/i

function isClosed(page) {
  try { return !page || (typeof page.isClosed === 'function' && page.isClosed()) } catch { return true }
}

// --------------------------------------------------------------------------
// Tab setup (mute + focus emulation + dynamic image interception)
// --------------------------------------------------------------------------
/**
 * Bring a tab up to the standard automation hygiene: muted, focus-emulated
 * (so Chrome never throttles its timers/network when the user switches away),
 * and request-intercepted with the dynamic `page.__adalAllowImages` policy.
 * Idempotent — safe to call on a tab the run already owns.
 */
export async function setupTab(page, { runId, mute = true } = {}) {
  if (!page) return page
  // The tab remembers its run in the page itself, so after a server restart
  // Adal Keep finds it again. Going to another site wipes window.name: it is
  // written again on every page load (the top page only, not its frames).
  if (runId !== undefined && runId !== null) {
    const name = (id) => { if (window === window.top) window.name = `adal-run-${id}` }
    try {
      page.evaluate?.(name, String(runId))?.catch?.(() => {})
      if (page.__adalNamed !== runId) { page.__adalNamed = runId; page.evaluateOnNewDocument?.(name, String(runId))?.catch?.(() => {}) }
    } catch {}
  }
  // A run never brings itself forward: only a person's Open does (LiveTab).
  page.bringToFront = async () => {}
  // A desktop page whatever the window's size: in a narrow one the sites fold
  // their menus away and the run cannot find them. It ends with the run.
  const desktopPage = () => page.__adalCdp?.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {})
  if (page.__adalSetup) {
    await desktopPage()
    if (runId !== undefined) page.__adalRunId = runId
    await setFileDialogs(page, true) // a resumed run takes the dialogs back
    return page
  }

  try {
    const cdp = await page.target().createCDPSession()
    page.__adalCdp = cdp
    try { await cdp.send('Page.setAudioMuted', { muted: mute }) } catch {}
    try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch {}
    page.__adalFocused = true
    await catchFileDialogs(page, cdp)
    await desktopPage()
  } catch (e) {
    console.log('[tabManager] cdp setup failed:', e.message)
  }

  try {
    await page.setRequestInterception(true)
    page.on('request', req => {
      // Only what the work needs comes down: no tracking scripts, videos or
      // sounds (and no pictures, except where the reCAPTCHA needs them). With
      // 3–4 runs at once every run gets more of the internet connection.
      const type = req.resourceType()
      const allowImages = page.__adalAllowImages === true
      if ((!allowImages && type === 'image') || type === 'media' || TRACKERS.test(hostOf(req.url()))) req.abort().catch(() => {})
      else req.continue().catch(() => {})
    })
  } catch (e) {
    console.log('[tabManager] request interception attach failed:', e.message)
  }

  // A person's clicks and keys in this tab (see isFree).
  const watch = () => {
    if (window.__adalWatch) return
    window.__adalWatch = true
    const mark = (e) => { if (e.isTrusted) try { sessionStorage.setItem('adal-touched', String(Date.now())) } catch {} }
    for (const ev of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, mark, true)
  }
  try { page.evaluateOnNewDocument?.(watch)?.catch?.(() => {}); page.evaluate?.(watch)?.catch?.(() => {}) } catch {}

  if (runId !== undefined) page.__adalRunId = runId
  page.__adalSetup = true
  return page
}

// --------------------------------------------------------------------------
// File dialogs — the system "Open file" window never opens in a run tab
// --------------------------------------------------------------------------
/*
 * Chrome asks the page's DevTools clients first when a page opens a file
 * dialog. A run tab always answers: with the file the run is attaching
 * (expectFile), or with nothing — then the dialog simply does not open.
 * When the run hands the tab to a person, the dialogs are given back
 * (setFileDialogs(page, false)) so the person can pick files by hand.
 */
async function catchFileDialogs(page, cdp) {
  await cdp.send('Page.enable').catch(() => {})
  cdp.on('Page.fileChooserOpened', async (ev) => {
    const want = page.__adalNextFile
    if (!want) {
      console.log(`[tabManager] run #${page.__adalRunId} file dialog blocked (no file was expected)`)
      return
    }
    page.__adalNextFile = null
    let ok = false
    if (ev.backendNodeId) {
      try {
        await cdp.send('DOM.setFileInputFiles', { files: want.files, backendNodeId: ev.backendNodeId })
        ok = true
      } catch (e) {
        console.log(`[tabManager] run #${page.__adalRunId} could not hand the file to the page: ${e.message}`)
      }
    }
    want.resolve(ok)
  })
  await setFileDialogs(page, true)
}

/** true: dialogs are caught (automation). false: a person gets them again. */
export async function setFileDialogs(page, intercept) {
  const cdp = page?.__adalCdp
  if (!cdp) return false
  try {
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: !!intercept })
    page.__adalDialogsCaught = !!intercept
    return true
  } catch { return false }
}

/**
 * Arm the tab: the next file dialog it opens receives `filePath`. Click the
 * page's Browse/dropzone after calling this. Resolves true when the file was
 * handed over, false when no dialog opened within `timeoutMs`.
 */
export function expectFile(page, filePath, timeoutMs = 10000) {
  disarmFile(page)
  return new Promise((resolve) => {
    const t = setTimeout(() => { if (page.__adalNextFile?.resolve === done) page.__adalNextFile = null; resolve(false) }, timeoutMs)
    const done = (ok) => { clearTimeout(t); resolve(ok) }
    page.__adalNextFile = { files: [filePath], resolve: done }
  })
}

/** Cancel a pending expectFile (it resolves false). */
export function disarmFile(page) {
  const prev = page?.__adalNextFile
  if (prev) { page.__adalNextFile = null; prev.resolve(false) }
}

// --------------------------------------------------------------------------
// Run → tab registry
// --------------------------------------------------------------------------
const _tabs = new Map() // runId -> Page

/** The tab a run owns, or null when it has none (or it was closed). */
export function tabOfRun(runId) {
  const id = Number(runId)
  const page = _tabs.get(id)
  if (!page) return null
  if (isClosed(page)) { _tabs.delete(id); return null }
  return page
}

// Which site each kind of run works on (to find its tab when nothing else does).
const RUN_HOSTS = [
  [/^musaned/, /musaned\.com\.sa|wahid\.sa/], [/^mofa|^visa/, /visa\.mofa\.gov\.sa/], [/^wafid/, /wafid\.com/],
  [/^insurance/, /niscofetap\.com/], [/^tasheer/, /tasheer\.com/], [/^(police|lmis|contract_import|delete_labour)/, /lmis\.gov\.et/],
]
const RUN_PEERS = [[/^musaned/, 'musaned'], [/^mofa|^visa/, 'mofa'], [/^insurance/, 'insurance'], [/^tasheer/, 'tasheer'], [/^(police|lmis|contract_import|delete_labour)/, 'lmis']]

/** The runs that still need their tabs (a paused one's tab waits for it). */
export async function activeRunIds(db) {
  const rows = await db('automation_queue').whereIn('status', ['pending', 'running', 'paused']).select('id').catch(() => [])
  return new Set(rows.map(r => Number(r.id)))
}

const PERSON_MS = 60000
const inTime = (p, ms = 3000) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))])

/** Is this tab free to take? (A frozen tab answers nothing: not free.) */
async function isFree(p, busyRuns) {
  if (p.__adalBorrowed || (p.__adalRunId !== undefined && !Number.isFinite(Number(p.__adalRunId)))) return false
  if (!(await outOfSight(p))) return false   // a run is never seen working: only in the agents' window
  const st = await inTime(p.evaluate(() => ({
    name: window.name,
    front: document.visibilityState === 'visible',
    touched: Number(sessionStorage.getItem('adal-touched')) || 0,
    typed: [...document.querySelectorAll('input, textarea')].some(e =>
      !['hidden', 'password', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(e.type) && e.value && e.value !== e.defaultValue),
  })).catch(() => null))
  if (!st) return false
  // A tab a run drove always says "visible" (its focus is faked), so there a
  // person shows by their clicks and keys since the run let go.
  if (p.__adalCdp ? Date.now() - st.touched < PERSON_MS : st.front) return false
  const run = /^adal-run-(\d+)$/.exec(st.name || '')?.[1]
  if (run) return !busyRuns.has(Number(run))
  return !!p.__adalCdp || !st.typed   // never a run's tab: what is typed there is a person's
}

/** A tab on this workflow's site nobody needs, signed in if there is one. */
async function findFreeTab(browser, workflowId, busyRuns) {
  const host = RUN_HOSTS.find(([w]) => w.test(String(workflowId)))?.[1]
  if (!host || !browser?.pages) return null
  const owned = new Set(_tabs.values())
  const peer = RUN_PEERS.find(([w]) => w.test(String(workflowId)))?.[1]
  const onSite = (await browser.pages().catch(() => [])).filter(p => !isClosed(p) && !owned.has(p) && host.test(p.url()))
  const signedIn = (p) => { try { return !!signedInHere[peer]?.(p.url()) } catch { return false } }
  for (const p of onSite.sort((a, b) => signedIn(b) - signedIn(a))) {
    if (await isFree(p, busyRuns)) return p
  }
  return null
}

// One at a time: two runs starting together must not take the same tab.
let _claims = Promise.resolve()
const oneAtATime = (fn) => { const p = _claims.then(fn, fn); _claims = p.catch(() => {}); return p }

/**
 * The run's tab even after a server restart (when the registry above is
 * empty): the tab named after the run, or the only tab on the run's site.
 * Found tabs are adopted, so the run also resumes in them.
 */
export async function findRunTab(browser, runId, workflowId = '', { bySite = true } = {}) {
  const known = tabOfRun(runId)
  if (known) return known
  if (!browser) return null
  const pages = await browser.pages().catch(() => [])
  let found = null
  for (const p of pages) {
    const name = await p.evaluate(() => window.name).catch(() => '')
    if (name === `adal-run-${runId}`) { found = p; break }
  }
  if (!found && bySite) {
    const host = RUN_HOSTS.find(([w]) => w.test(String(workflowId)))?.[1]
    const onSite = host ? pages.filter(p => host.test(p.url())) : []
    if (onSite.length === 1) found = onSite[0]
  }
  if (found) {
    _tabs.set(Number(runId), found)
    await setupTab(found, { runId: Number(runId) }).catch(() => {})
    console.log(`[tabManager] run #${runId} found its tab again (${found.url().slice(0, 60)})`)
  }
  return found
}

/** Run ids that own an open tab right now. */
export function runsWithTabs() {
  return [..._tabs.keys()].filter(id => tabOfRun(id))
}

/**
 * The tab this run works in. A run that paused for a person (sign-in, OTP,
 * Submit) gets the same tab back when it resumes; otherwise a free tab on its
 * site, else a new tab. The run then goes to the page it needs by itself.
 */
export async function openRunTab(browser, runId, { workflowId = '', busyRuns = new Set() } = {}) {
  const id = Number(runId)
  const own = tabOfRun(id)
  if (own) {
    await setupTab(own, { runId: id })
    console.log(`[tabManager] run #${id} back in its own tab`)
    return own
  }
  if (!browser || typeof browser.newPage !== 'function') throw new Error('No browser to open a tab in')
  const free = await oneAtATime(async () => {
    const p = await findFreeTab(browser, workflowId, busyRuns)
    if (p) _tabs.set(id, p)
    return p
  })
  if (free) {
    await letPageGo(free)
    free.__adalReused = free.url()
    await setupTab(free, { runId: id })
    console.log(`[tabManager] run #${id} took the free tab on ${free.url().slice(0, 60)}`)
    return free
  }
  const page = await newRunTab(browser)
  _tabs.set(id, page)
  await setupTab(page, { runId: id })
  console.log(`[tabManager] run #${id} opened its own tab (${runsWithTabs().length} run tab(s) open)`)
  return page
}

/** "Leave site?" would stop the run's first page load in a tab that was in use. */
async function letPageGo(page) {
  if (page.__adalLeaves) return
  page.__adalLeaves = true
  page.on('dialog', d => { if (d.type() === 'beforeunload') d.accept().catch(() => {}) })
}

/**
 * For a background check (not a run): a free tab on the site, or a new one.
 * doneWithTab() afterwards closes only a tab the check opened itself.
 */
export async function borrowTab(browser, workflowId, busyRuns = new Set()) {
  const free = await oneAtATime(async () => {
    const p = await findFreeTab(browser, workflowId, busyRuns)
    if (p) p.__adalBorrowed = true
    return p
  })
  if (free) await letPageGo(free)
  return free || newRunTab(browser)
}
export async function doneWithTab(page) {
  if (!page) return
  if (!page.__adalBorrowed) { await page.close().catch(() => {}); return }
  page.__adalBorrowed = false
  page.__adalRunId = undefined
  handTabToPerson(page)
}

/**
 * Let go of a run's tab WITHOUT closing it (a failed run: the operator can
 * still look at what the portal showed). No run will ever use it again.
 */
export function forgetRunTab(runId) {
  const page = tabOfRun(runId)
  page?.__adalCdp?.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  if (page) handTabToPerson(page)
  return _tabs.delete(Number(runId))
}

/** The run stops driving this tab (paused for a person, failed, done). */
export function handTabToPerson(page) {
  disarmFile(page)
  setFileDialogs(page, false).catch(() => {})
  // The run's own clicks count as "trusted" too: only what comes after is a person's.
  try { page.evaluate?.(() => { try { sessionStorage.removeItem('adal-touched') } catch {} })?.catch?.(() => {}) } catch {}
}

/** Close the tab this run owns. Returns true when a tab was closed. */
export async function closeRunTab(runId) {
  const id = Number(runId)
  const page = _tabs.get(id)
  _tabs.delete(id)
  if (isClosed(page)) return false
  try {
    await page.close()
  } catch {
    return false
  }
  console.log(`[tabManager] run #${id} tab closed`)
  return true
}

// --------------------------------------------------------------------------
// One sign-in shared by every tab
// --------------------------------------------------------------------------
/**
 * Runs on the same portal take turns signing in: a second run waits while
 * the first one signs in (and a person types the code), then finds the
 * portal signed in and asks for no new code. Returns a release function.
 */
const _turns = {}
export function signInTurn(peer) {
  const before = _turns[peer] || Promise.resolve()
  let release
  const mine = new Promise(r => { release = r })
  _turns[peer] = before.then(() => mine)
  let done = false
  return before.then(() => () => { if (!done) { done = true; release() } })
}

/** A tab that is signed in to the portal (the person's or another run's). */
const signedInHere = {
  lmis: (url) => isPeerUrl(url, 'lmis') && !/\/(auth|login)/i.test(new URL(url).pathname),
  musaned: (url) => hostOf(url) === 'tawtheeq.musaned.com.sa',
  insurance: (url) => isPeerUrl(url, 'insurance') && !/(login|sign-?in|auth)/i.test(new URL(url).pathname),
  mofa: (url) => isPeerUrl(url, 'mofa') && !/\/account\/login/i.test(new URL(url).pathname),
  tasheer: (url) => isPeerUrl(url, 'tasheer') && /\/auth\//i.test(new URL(url).pathname),
}

/**
 * Before a run signs in: when another tab is already signed in to this
 * portal, its sign-in is used. Cookies are shared by every tab; what a portal
 * keeps per tab (sessionStorage) is copied into this tab before its pages
 * load. Returns the address of that signed-in tab, or null.
 */
export async function borrowSignIn(page, peer) {
  const isIn = signedInHere[peer]
  if (!isIn || !page?.browser) return null
  // This tab too: one taken from an earlier run is usually signed in itself.
  for (const t of page.browser().targets()) {
    if (t.type() !== 'page') continue
    let url = ''
    try { url = t.url() } catch { continue }
    if (!isIn(url)) continue
    const other = await t.page().catch(() => null)
    if (!other) continue
    const st = await other.evaluate(() => ({
      pw: !!document.querySelector('input[type="password"]'),
      data: JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)]))),
    })).catch(() => null)
    if (!st || st.pw) continue
    await page.evaluateOnNewDocument((data, hosts) => {
      try {
        const h = location.hostname
        if (!hosts.some(x => h === x || h.endsWith('.' + x))) return
        const o = JSON.parse(data)
        for (const k of Object.keys(o)) if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, o[k])
      } catch {}
    }, st.data, PEERS[peer].hosts).catch(() => {})
    return url
  }
  return null
}


/**
 * The sites in English before a run starts: the steps look for English words.
 * Each site's switch shows only when it is in Arabic (Keycloak's sign-in page
 * lists both languages, so its own language is asked there).
 */
export async function toEnglish(page, ctx) {
  const how = await page.evaluate(() => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const visa = [...document.querySelectorAll('a.language[id^="en"]')].find(seen)
    if (visa) { visa.click(); return 'switch' }
    const musaned = document.querySelector('a[applangswitcher]')
    if (musaned && /^(en|english)$/i.test(musaned.textContent.trim())) { musaned.click(); return 'switch' }
    const signIn = /^ar/i.test(document.documentElement.lang) && document.querySelector('a[href*="kc_locale=en"]')
    if (signIn) { signIn.click(); return 'link' }
    return ''
  }).catch(() => '')
  if (!how) return false
  ctx?.onLog?.('info', '🌐 changing the site to English')
  await new Promise(r => setTimeout(r, 3000)) // the page reloads in English
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {})
  return true
}

// Runs in the page: the visible boxes that take a sign-in code.
const codeBoxes = () => {
  const vis = (e) => e && e.offsetParent !== null && !e.disabled && !e.readOnly
  return [...document.querySelectorAll('input')].filter(vis).filter(e => /otp|totp|code|one-time|verification/i.test(`${e.name} ${e.id} ${e.autocomplete} ${e.placeholder} ${e.getAttribute('formcontrolname') || ''}`) || (e.maxLength === 1 && /text|tel|number/.test(e.type)))
}

/** Is a code box on the page now? */
export const codeBoxUp = (page) => page.evaluate(`(${codeBoxes})().length > 0`).catch(() => false)

/** Types a sign-in code into the page's code box(es). False when there is none. */
export async function typeCodeInto(page, code) {
  const fill = (boxes, code) => {
    const set = (el, v) => {
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      el.focus(); proto.set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const singles = boxes.filter(e => e.maxLength === 1)
    if (singles.length >= code.length) { singles.slice(0, code.length).forEach((el, i) => set(el, code[i])); return 'boxes' }
    if (boxes[0]) { set(boxes[0], code); return 'box' }
    return ''
  }
  return !!(await page.evaluate(`(${fill})((${codeBoxes})(), ${JSON.stringify(String(code))})`).catch(() => ''))
}

/** Presses the button that sends a typed code. */
export async function pressCodeButton(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, input[type="submit"]')].filter(e => e.offsetParent !== null && !e.disabled)
      .find(e => /sign\s*in|verify|confirm|log\s*in|submit|continue|تحقق|تسجيل|دخول|تأكيد/i.test(e.innerText || e.value || ''))
    b?.click()
  }).catch(() => {})
}
