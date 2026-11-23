import { useEffect, useState } from 'react'

/**
 * A document's picture that never shows a broken icon (asked on 2026-11-23): a photo listed
 * here whose file is still on its way from another PC (the server fetches it at once, see
 * backend services/fileOnDemand.js) shows "Loading the photo…" and is asked for again;
 * after a while it says so plainly, with Try again.
 */
const WAITS = [1500, 3000, 5000, 8000, 12000, 20000]

export default function FileImage({ src, alt = '', className = '', onClick, ...rest }) {
  const [tries, setTries] = useState(0)
  const [state, setState] = useState('loading')   // loading | ok | waiting | gone
  useEffect(() => { setTries(0); setState('loading') }, [src])
  useEffect(() => {
    if (state !== 'waiting') return
    if (tries >= WAITS.length) { setState('gone'); return }
    const t = setTimeout(() => { setTries(n => n + 1); setState('loading') }, WAITS[tries])
    return () => clearTimeout(t)
  }, [state, tries])
  const url = tries ? `${src}${src.includes('?') ? '&' : '?'}r=${tries}` : src
  return (
    <>
      {state !== 'gone' && state !== 'waiting' && (
        <img src={url} alt={alt} onClick={onClick} {...rest}
          className={`${className} ${state === 'ok' ? '' : 'opacity-0'}`}
          onLoad={() => setState('ok')} onError={() => setState('waiting')} />
      )}
      {state !== 'ok' && (
        <div data-testid="file-image-wait" onClick={(e) => e.stopPropagation()}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center text-xs text-slate-500 dark:text-slate-400">
          {state === 'gone' ? (
            <>
              <span>The photo is not on this PC yet. It shows here when the copy arrives.</span>
              <button type="button" onClick={() => { setTries(0); setState('loading') }}
                className="rounded-lg border border-slate-300 px-2 py-1 font-semibold hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800">↻ Try again</button>
            </>
          ) : (
            <>
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-teal-600" />
              <span>Loading the photo…</span>
            </>
          )}
        </div>
      )}
    </>
  )
}
