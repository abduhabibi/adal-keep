import { useEffect, useState } from 'react'
import { off } from '../../lib/offSwitch'

/**
 * One Adal Keep tab in the person's own browser (the launcher opens Adal Keep there since
 * 2026-11-27, adal-launcher/defaultbrowser.go). Clicking Adal Keep again opens a new tab:
 * the older one steps aside (a cover, its timers asleep as in any tab behind) and says so,
 * with "Use this tab" to take it back. Only on this PC's own door (127.0.0.1:47802) — the
 * Admin's agency windows, a Companion's or a phone's are never covered.
 * Off: ?adal_off=onetab
 */
const CHANNEL = 'adal-keep-tab'
const here = () => { try { return location.host === '127.0.0.1:47802' } catch { return false } }
const AWAY_TITLE = '⏸ Adal Keep (open in another tab)'

export default function OneTab() {
  const [aside, setAside] = useState(false)
  const [bc, setBc] = useState(null)
  useEffect(() => {
    if (off('onetab') || !here() || typeof BroadcastChannel === 'undefined') return
    let c
    try { c = new BroadcastChannel(CHANNEL) } catch { return }
    const id = Math.random().toString(36).slice(2)
    c.onmessage = (e) => { if (e.data?.t === 'here' && e.data.id !== id) setAside(true) }
    const claim = () => { try { c.postMessage({ t: 'here', id }) } catch {} }
    c.claim = claim
    claim()
    setBc(c)
    return () => { try { c.close() } catch {} }
  }, [])
  // The launcher brings a window showing "Adal …" to the front: a tab that stepped aside is not that one.
  useEffect(() => {
    if (!aside) return
    const before = document.title
    document.title = AWAY_TITLE
    return () => { if (document.title === AWAY_TITLE) document.title = before }
  }, [aside])
  if (!aside) return null
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-6">
      <div className="max-w-sm w-full rounded-2xl bg-white dark:bg-slate-800 p-6 text-center shadow-xl">
        <div className="text-4xl mb-3">🗂️</div>
        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-1">Adal Keep is open in another tab</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">You can close this tab. Or keep working here: the other tab steps aside.</p>
        <button
          className="w-full rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-medium py-2.5"
          onClick={() => { bc?.claim?.(); setAside(false) }}
        >Use this tab</button>
      </div>
    </div>
  )
}
