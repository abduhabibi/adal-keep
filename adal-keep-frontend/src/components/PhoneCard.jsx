import { useEffect, useState } from 'react'
import Card from './shared/Card'
import SmsCodesSwitch from './SmsCodesSwitch'

const plugin = () => window.Capacitor?.Plugins?.AdalDiscovery

/** Notifications with the app closed (also swiped away): what Android allows, and where to allow the rest. */
function NoticesRow() {
  const [st, setSt] = useState(null)
  const load = () => plugin()?.noticeState?.().then(setSt).catch(() => setSt(null))
  useEffect(() => {
    load()
    const on = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  if (!plugin()?.noticeState) return null
  const ok = st?.allowed && st?.background
  return (
    <div className={`mt-3 rounded-xl border p-3 ${ok ? 'border-emerald-200 dark:border-emerald-800' : 'border-amber-300 dark:border-amber-700'}`}>
      <p className="text-sm font-semibold">🔔 Notifications when the app is closed {ok ? <span className="text-emerald-600">— on</span> : <span className="text-amber-600">— not fully allowed</span>}</p>
      <ul className="mt-2 space-y-1 text-xs">
        <li>{st?.allowed ? '✅' : '❌'} Notifications allowed</li>
        <li>{st?.background ? '✅' : '❌'} Runs in the background (no battery saving)</li>
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        {!st?.background && <button type="button" onClick={() => plugin().letRunInBackground({}).catch(() => {})} className="rounded-full bg-teal-600 px-3 py-1.5 text-xs font-bold text-white">Allow in the background</button>}
        <button type="button" onClick={() => plugin().letRunInBackground({ settings: true }).catch(() => {})} className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold dark:border-slate-700">App settings (auto-start, battery)</button>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">Tecno, Infinix, itel, Xiaomi, Oppo: also turn on <b>Auto-start</b> for Adal Keep in App settings (or the phone's Phone Master / Security app), and lock it in the recent apps.</p>
    </div>
  )
}

/**
 * Settings → This phone (only in the phone app): is the office PC live,
 * the app's version and its update, pairing with another agency.
 * (It used to be a bar along the bottom of every page.)
 */
export default function PhoneCard() {
  const [pc, setPc] = useState(!!window.__adalPcOnline)
  const [up, setUp] = useState(window.__adalUpdate || {})
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const onPc = (e) => setPc(!!e.detail)
    const onUp = (e) => setUp({ ...(e.detail || {}) })
    window.addEventListener('adal-pc-online', onPc)
    window.addEventListener('adal-update', onUp)
    return () => { window.removeEventListener('adal-pc-online', onPc); window.removeEventListener('adal-update', onUp) }
  }, [])
  const check = async () => { setChecking(true); try { await window.__adalCheckUpdate?.() } finally { setChecking(false) } }
  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-3 flex items-center gap-2">This phone</h2>
      <div className={`flex items-center gap-3 rounded-xl p-3 ${pc ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'bg-teal-50 dark:bg-teal-900/20'}`}>
        <span className={`h-2.5 w-2.5 rounded-full ${pc ? 'bg-indigo-500 animate-pulse' : 'bg-teal-500'}`} />
        <div className="text-sm">
          <p className="font-semibold">{pc ? '⚡ Live with the office PC' : '☁️ The office PC is off'}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{pc
            ? 'Everything happens at once on the PC.'
            : 'Pages show the online copy; what you change is done when the PC is on.'}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">App {up.mine ? `version ${up.mine}` : ''}</span>
        {up.newer
          ? <button type="button" onClick={() => window.__adalInstallUpdate?.()} disabled={up.busy}
              className="rounded-full bg-red-600 px-3 py-1.5 text-xs font-bold text-white">{up.busy ? '⬇ Downloading…' : `⬆ Update available (${up.latest}) — install`}</button>
          : <button type="button" onClick={check} disabled={checking}
              className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold dark:border-slate-700">{checking ? 'Looking…' : up.checkedAt ? '✓ Newest — look again' : 'Look for an update'}</button>}
        <button type="button" onClick={() => { if (confirm('Pair this phone with another agency (its PC number)?')) window.__adalPair?.() }}
          className="ml-auto rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold dark:border-slate-700">Pair with another agency</button>
      </div>
      <NoticesRow />
      <SmsCodesSwitch />
    </Card>
  )
}
