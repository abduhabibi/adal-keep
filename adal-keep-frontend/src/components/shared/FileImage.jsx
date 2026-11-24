import { useEffect, useRef, useState } from 'react'

/**
 * A document's picture that never shows a broken icon and never spins for ever
 * (asked on 2026-11-24: "Loading the photo…" for ever on Original_image.png — "don't make it load").
 *
 *   on this PC          shows at once
 *   on another PC only  within 3 s: "This photo is on another PC — it comes when that PC is on"
 *                       with Retry (the server fetches it behind, see backend services/fileOnDemand.js;
 *                       it is asked for again quietly every 20 s)
 *   a broken file       says so
 *
 * After 3 s without the picture (or when it fails) the server is asked why, in 3 s at most.
 */
const DECIDE_MS = 3000
const AGAIN_MS = 20000

async function why(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(DECIDE_MS) })
    if (r.ok) return 'ok'
    if (r.headers.get('X-Adal-Pending') === '1') return 'away'
    return r.status === 404 ? 'missing' : 'broken'
  } catch { return 'away' }   // no answer in time: the file is being fetched from another PC
}

export default function FileImage({ src, alt = '', className = '', onClick, ...rest }) {
  const [tries, setTries] = useState(0)
  const [state, setState] = useState('loading')   // loading | ok | away | missing | broken
  const stateRef = useRef(state)
  stateRef.current = state
  useEffect(() => { setTries(0); setState('loading') }, [src])
  const url = tries ? `${src}${src.includes('?') ? '&' : '?'}r=${tries}` : src

  // Why it does not show: asked after 3 s, or at once when the picture fails.
  const ask = async (failed) => {
    const w = await why(url)
    if (stateRef.current === 'ok') return
    if (w === 'ok') { if (failed) setState('broken'); return }   // the file is there: slow (wait) or damaged
    setState(w)
  }
  useEffect(() => {
    if (state !== 'loading') return
    const t = setTimeout(() => ask(false), DECIDE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, url])
  // On another PC: asked for again quietly; it shows by itself when it is here.
  useEffect(() => {
    if (state !== 'away') return
    const t = setTimeout(() => { setTries(n => n + 1); setState('loading') }, AGAIN_MS)
    return () => clearTimeout(t)
  }, [state])

  const retry = (e) => { e.stopPropagation(); setTries(n => n + 1); setState('loading') }
  const WORDS = {
    away: 'This photo is on another PC — it comes when that PC is on.',
    missing: 'This photo’s file is not on this PC. Upload it again.',
    broken: 'This photo’s file is damaged and cannot be shown. Upload it again.',
  }
  return (
    <>
      {state !== 'missing' && state !== 'broken' && (
        <img src={url} alt={alt} onClick={onClick} {...rest}
          className={`${className} ${state === 'ok' ? '' : 'opacity-0'}`}
          onLoad={() => setState('ok')} onError={() => ask(true)} />
      )}
      {state !== 'ok' && (
        <div data-testid="file-image-wait" data-state={state} onClick={(e) => e.stopPropagation()} title={WORDS[state] || 'Loading the photo…'}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-hidden p-2 text-center text-xs text-slate-500 dark:text-slate-400">
          {state === 'loading' ? (
            <>
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-teal-600" />
              <span>Loading the photo…</span>
            </>
          ) : (
            <>
              <span className={state === 'away' ? '' : 'text-red-600 dark:text-red-400'}>{WORDS[state]}</span>
              <button type="button" onClick={retry}
                className="rounded-lg border border-slate-300 px-2 py-1 font-semibold hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800">↻ Retry</button>
            </>
          )}
        </div>
      )}
    </>
  )
}
