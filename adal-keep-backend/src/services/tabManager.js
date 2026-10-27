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
 *   openRunTab(browser, runId) → the run's own tab. A new run always gets a
 *                                new tab; a resumed run gets its tab back.
 *   tabOfRun(runId)            → that tab, or null.
 *   closeRunTab(runId)         → closes that tab and nothing else.
 *
 * This registry (runId → tab) is the only way a tab is ever found. A run
 * never touches a tab it does not own, and tabs the operator opened are
 * never adopted, navigated or closed.
 *
 * All tabs live in the browser's shared default context, so cookies are
 * shared: a new tab on a portal the browser is logged into stays logged in.
 *
 * Cross-platform: pure Puppeteer/CDP — Windows / macOS / Linux identical.
 */

export const PEERS = {
  musaned: { hosts: ['tawtheeq.musaned.com.sa', 'accounts.wahid.sa'], label: 'Musaned' },
  lmis:    { hosts: ['lmis.gov.et'],                                  label: 'LMIS' },
  mofa:    { hosts: ['visa.mofa.gov.sa'],                             label: 'Visa platform' },
  insurance: { hosts: ['agency.niscofetap.com'],                        label: 'Insurance (FetaP)' },
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
  // The tab remembers its run in the page itself (window.name survives
  // navigations), so after a server restart Adal Keep finds it again.
  if (runId !== undefined && runId !== null) {
    try { page.evaluate?.((id) => { window.name = `adal-run-${id}` }, String(runId))?.catch?.(() => {}) } catch {}
  }
  if (page.__adalSetup) {
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
  [/^insurance/, /niscofetap\.com/], [/^(police|lmis)/, /lmis\.gov\.et/],
]

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
 * Submit) gets the same tab back when it resumes; otherwise a new tab.
 * Never a tab that belongs to another run or to the operator.
 */
export async function openRunTab(browser, runId) {
  const id = Number(runId)
  const own = tabOfRun(id)
  if (own) {
    await setupTab(own, { runId: id })
    console.log(`[tabManager] run #${id} back in its own tab`)
    return own
  }
  if (!browser || typeof browser.newPage !== 'function') throw new Error('No browser to open a tab in')
  const page = await browser.newPage()
  _tabs.set(id, page)
  await setupTab(page, { runId: id })
  console.log(`[tabManager] run #${id} opened its own tab (${runsWithTabs().length} run tab(s) open)`)
  return page
}

/**
 * Let go of a run's tab WITHOUT closing it (a failed run: the operator can
 * still look at what the portal showed). No run will ever use it again.
 */
export function forgetRunTab(runId) {
  const page = tabOfRun(runId)
  if (page) handTabToPerson(page)
  return _tabs.delete(Number(runId))
}

/** The run stops driving this tab (paused for a person, failed, done). */
export function handTabToPerson(page) {
  disarmFile(page)
  setFileDialogs(page, false).catch(() => {})
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
  const self = page.target()
  for (const t of page.browser().targets()) {
    if (t === self || t.type() !== 'page') continue
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

