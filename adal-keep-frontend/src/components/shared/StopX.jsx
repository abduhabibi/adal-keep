import toast from 'react-hot-toast'
import { off } from '../../lib/offSwitch'

/**
 * The X beside everything Adal Keep waits for (the owner, 2026-11-26): one click stops waiting,
 * closes what was opening and leaves the person where they were. What it does to the work
 * itself is said by the caller: stopped there too, or "it goes on on the PC".
 * Off: "stopx" in the window's off switch (the X is not shown; everything waits as before).
 */
export const stopOn = () => !off('stopx')

export default function StopX({ onStop, title = 'Stop', className = '', light = false }) {
  if (!stopOn() || !onStop) return null
  return (
    <button type="button" data-testid="stop-x" title={title} aria-label={title}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStop() }}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold leading-none ${light ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-slate-200 text-slate-600 hover:bg-red-100 hover:text-red-700 dark:bg-slate-700 dark:text-slate-200'} ${className}`}>×</button>
  )
}

/** Back where the person was: the page before, else the start page. */
export function goBack(navigate) {
  if ((window.history.state?.idx || 0) > 0) navigate(-1)
  else navigate('/', { replace: true })
}

/**
 * toast.loading with the X. onStop runs on the click; said: what the toast says after it
 * (default "Stopped."). Returns the toast's id, as toast.loading does.
 */
export function waitToast(text, { id, onStop, said = 'Stopped.' } = {}) {
  const tid = id || `wait-${Math.random().toString(36).slice(2)}`
  toast.loading(
    <span className="flex items-center gap-2">
      <span>{text}</span>
      <StopX onStop={() => { try { onStop?.() } finally { toast(said, { id: tid, icon: '✋', duration: 6000 }) } }} />
    </span>, { id: tid, duration: Infinity })
  return tid
}

/** An axios call that the X can stop: { signal, stop, stopped() }. */
export function stopper() {
  const c = new AbortController()
  return { signal: c.signal, stop: () => c.abort(), stopped: () => c.signal.aborted }
}
export const wasStopped = (e) => e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || e?.name === 'AbortError'
