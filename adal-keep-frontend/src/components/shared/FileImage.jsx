import { useEffect, useRef, useState } from 'react'
import { pic, picNow, dropPic, picsOn } from '../../lib/pics'

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
 * keep: its key (lib/pics.js): the small picture is kept on this device and shown at once
 *   next time — no wheel, no request. A wheel only after SPIN_MS, never a flash of one.
 * under: its small picture (already on the page), shown at once while the big one comes.
 *
 * After 3 s without the picture (or when it fails) the server is asked why, in 3 s at most.
 */
const DECIDE_MS = 3000
const AGAIN_MS = 20000
const SPIN_MS = 700

async function why(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(DECIDE_MS) })
    if (r.ok) return 'ok'
    if (r.headers.get('X-Adal-Pending') === '1') return 'away'
    return r.status === 404 ? 'missing' : 'broken'
  } catch { return 'away' }   // no answer in time: the file is being fetched from another PC
}

export default function FileImage(props) {
  const { src, under = null, keep = null, underKeep = null, ...rest } = props
  const on = picsOn()
  if (on && keep) return <KeptImage key={keep} {...props} />
  return <LoadedImage key={src} {...rest} src={src} under={(on && picNow(underKeep)) || under} />
}

const WORDS = {
  away: 'This photo is on another PC — it comes when that PC is on.',
  quiet: 'The PC is not answering — the photo is asked for again.',
  missing: 'This photo’s file is not on this PC. Upload it again.',
  broken: 'This photo’s file is damaged and cannot be shown. Upload it again.',
}

/** The wheel, only when it takes a moment. */
function Wheel() {
  const [late, setLate] = useState(false)
  useEffect(() => { const t = setTimeout(() => setLate(true), SPIN_MS); return () => clearTimeout(t) }, [])
  return late ? <><span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-teal-600" /><span>Loading the photo…</span></> : null
}

function Waiting({ state, retry, under = null }) {
  return (
    <div data-testid="file-image-wait" data-state={state} onClick={(e) => e.stopPropagation()} title={WORDS[state] || ''}
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-hidden p-2 text-center text-xs text-slate-500 dark:text-slate-400">
      {state === 'loading' && under && (
        // Its file is on another PC too: no broken icon, only the wheel.
        <img src={under} alt="" data-testid="file-image-under" onError={(e) => { e.currentTarget.style.display = 'none' }}
          className="absolute inset-0 h-full w-full rounded-3xl object-contain" />
      )}
      {state === 'loading' ? <Wheel /> : (
        <>
          <span className={state === 'away' || state === 'quiet' ? '' : 'text-red-600 dark:text-red-400'}>{WORDS[state]}</span>
          <button type="button" onClick={retry}
            className="rounded-lg border border-slate-300 px-2 py-1 font-semibold hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800">↻ Retry</button>
        </>
      )}
    </div>
  )
}

/** A small picture from this device (lib/pics.js), else from the PC once. */
function KeptImage({ src, keep, under: _u, underKeep: _k, alt = '', className = '', onClick, ...rest }) {
  const [url, setUrl] = useState(() => picNow(keep))
  const [state, setState] = useState('loading')   // (only without a url) loading | away | quiet | missing | broken
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (url) return
    let alive = true
    pic(keep, tries ? `${src}${src.includes('?') ? '&' : '?'}r=${tries}` : src)
      .then(u => alive && setUrl(u), e => alive && setState(e.state || 'quiet'))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keep, tries, url])
  useEffect(() => {
    if (url || (state !== 'away' && state !== 'quiet')) return
    const t = setTimeout(() => { setTries(n => n + 1); setState('loading') }, AGAIN_MS)
    return () => clearTimeout(t)
  }, [url, state])
  const retry = (e) => { e.stopPropagation(); setTries(n => n + 1); setState('loading') }
  const failed = useRef(false)
  if (!url) return <Waiting state={state} retry={retry} />
  return <img src={url} data-file={src} alt={alt} onClick={onClick} {...rest} className={className}
    onError={() => { dropPic(keep); if (failed.current) { setUrl(null); setState('broken') } else { failed.current = true; setUrl(null); setTries(n => n + 1) } }} />
}

function LoadedImage({ src, under = null, alt = '', className = '', onClick, ...rest }) {
  const [tries, setTries] = useState(0)
  const [state, setState] = useState('loading')   // loading | ok | away | missing | broken
  const stateRef = useRef(state)
  stateRef.current = state
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
  return (
    <>
      {state !== 'missing' && state !== 'broken' && (
        <img src={url} alt={alt} onClick={onClick} {...rest}
          className={`${className} ${state === 'ok' ? '' : 'opacity-0'}`}
          onLoad={() => setState('ok')} onError={() => ask(true)} />
      )}
      {state !== 'ok' && <Waiting state={state} retry={retry} under={under} />}
    </>
  )
}
