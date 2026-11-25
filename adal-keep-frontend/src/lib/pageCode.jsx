/**
 * The pages' code (each page is its own file, fetched when it is first opened).
 *
 *   - Never a blank page: the page before stays on the screen until the next one's
 *     code is here (App.jsx turns on React Router's transitions), with a thin line on top.
 *   - Never a reload: a file that does not come is asked for again (3 times), then the
 *     page says so with a Try again; a newer Adal Keep is opened by a person's click only.
 *   - Fetched ahead: the pages used most, as soon as the first page stands.
 *
 * Off: localStorage 'adal-off' holding "pages" (the pages then show "…" while they come, no retries).
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { off } from './offSwitch'

const WAITS = [400, 1500, 4000]
const pause = (ms) => new Promise(r => setTimeout(r, ms))

let waiting = 0
const tell = () => { try { window.dispatchEvent(new CustomEvent('adal-page-code', { detail: waiting })) } catch {} }

/** The file's own address, as Chrome's message names it (a failed import is remembered by the browser: asked again under another address). */
export const addressIn = (e) => /(https?:\/\/[^\s'")]+\.js)/.exec(String(e?.message || ''))?.[1] || null

/** load() until it works: the file again under a new address, then the whole import. */
export async function persist(load, { waits = WAITS, again = (url) => import(/* @vite-ignore */ url), sleep = pause } = {}) {
  let err
  for (let i = 0; i <= waits.length; i++) {
    if (i) await sleep(waits[i - 1])
    try {
      if (!i) return await load()
      const url = addressIn(err)
      return url ? await again(`${url.split('?')[0]}?again=${Date.now()}`) : await load()
    } catch (e) { err = addressIn(e) ? e : (err || e) }
  }
  throw Object.assign(new Error('This page’s code did not come from the PC. Nothing is lost: press Try again in a moment.'), { pageCode: true, cause: err })
}

const all = []
/**
 * A page from its import: like React.lazy, but drawn at once when its code is
 * already here, and able to try again after a failure (Page.retry, used by the
 * ErrorBoundary's Try again).
 */
export function lazyPage(load, pick = (m) => m.default) {
  let mod = null, going = null, L = null
  const get = () => mod ? Promise.resolve(mod) : going ||= (async () => {
    waiting++; tell()
    try { return (mod = { default: pick(await (off('pages') ? load() : persist(load))) }) } finally { waiting--; going = null; tell() }
  })()
  const fresh = () => { L = lazy(get) }
  fresh()
  function Page(props) {
    // Kept for as long as it is shown (a change of kind half way would start the page over).
    const [P] = useState(() => mod?.default || null)
    return P ? <P {...props} /> : <L {...props} />
  }
  Page.preload = () => get()
  Page.retry = () => { if (!mod) fresh() }
  all.push(Page)
  return Page
}
export const retryPages = () => all.forEach(p => p.retry())

/** The pages' code, one after the other while the window has a moment (never later than 1.5 s each). */
export function warmPages(list) {
  const idle = () => new Promise(r => (window.requestIdleCallback ? window.requestIdleCallback(r, { timeout: 1500 }) : setTimeout(r, 50)))
  return list.reduce((p, page) => p.then(idle).then(() => page.preload().catch(() => {})), Promise.resolve())
}

/** A part of a page whose code is fetched only when shown (the live tab, the browser view). */
export const lazyPart = (load) => lazy(() => off('pages') ? load() : persist(load))

/** A thin line on top while a page's code comes (only when it takes a moment). */
export function PageComing() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let t = null
    const f = (e) => { clearTimeout(t); if (e.detail > 0) t = setTimeout(() => setOn(true), 150); else setOn(false) }
    window.addEventListener('adal-page-code', f)
    return () => { clearTimeout(t); window.removeEventListener('adal-page-code', f) }
  }, [])
  return on ? <div data-testid="page-coming" role="status" aria-label="Opening…" className="pointer-events-none fixed left-0 right-0 top-0 z-[9998] h-1 animate-pulse bg-teal-500" /> : null
}

/** The first page ever (nothing to keep on the screen yet): said in words, never white. */
export function FirstPage({ children }) {
  return <Suspense fallback={<div data-testid="page-first" className="flex h-64 items-center justify-center text-sm text-slate-500 dark:text-slate-400">Opening…</div>}>{children}</Suspense>
}
