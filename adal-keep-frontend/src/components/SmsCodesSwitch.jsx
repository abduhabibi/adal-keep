/**
 * Settings → This phone → "Send LMIS codes to Adal Keep": LMIS sends its
 * sign-in code by SMS to the number of the LMIS account; with this on, the
 * phone app reads LMIS's SMS on this phone and passes just the code to the
 * main PC (adal-phone SmsCodeReceiver). The LMIS robot types it, and every
 * PC's document tray shows it with a Copy button (asked on 2026-11-15), so
 * the code no longer depends on one person's phone being at hand. Only LMIS
 * messages are looked at; nothing else is read, kept or sent. The person
 * ticks the LMIS account(s) whose number is this phone's SIM: each code says
 * which account it is for.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

const plugin = () => window.Capacitor?.Plugins?.AdalDiscovery
const nameOf = (a) => `${a.name || 'LMIS'}${a.phone ? ` · ${a.phone}` : ''}`

export default function SmsCodesSwitch() {
  const [st, setSt] = useState(null)   // { on, allowed, account }
  const [accounts, setAccounts] = useState([])
  const load = () => plugin()?.smsForward?.({}).then(setSt).catch(() => setSt(null))
  useEffect(() => {
    load()
    api.get('/lmis/accounts').then(r => setAccounts(Array.isArray(r.data) ? r.data : [])).catch(() => {})
  }, [])
  if (!plugin()?.smsForward) return null
  const chosen = String(st?.account || '').split(' | ').filter(Boolean)
  const send = async (account) => {
    // The online-copy code (60 kB) only when this is switched: Settings on a PC never needs it.
    const { cloudCreds } = await import('../cloud/adapter.js')
    const c = cloudCreds()
    if (!c?.email) { toast.error('Pair this phone with the office PC first'); return null }
    return plugin().smsForward({ on: true, url: c.url, anon: c.anon, email: c.email, password: c.password, agency: c.agency, account })
  }
  const flip = async () => {
    try {
      if (st?.on) { setSt(await plugin().smsForward({ on: false })); return toast.success('LMIS codes are not sent any more') }
      // One LMIS account: it is this phone's number.
      const r = await send(chosen.length ? chosen.join(' | ') : accounts.length === 1 ? nameOf(accounts[0]) : '')
      if (!r) return
      setSt(r)
      toast.success(r.allowed ? 'LMIS codes now go to Adal Keep by themselves' : 'Allow "SMS" when Android asks — then LMIS codes go to Adal Keep', { duration: 7000 })
      setTimeout(load, 4000)
    } catch (e) { toast.error(e.message) }
  }
  const pick = async (a) => {
    const n = nameOf(a)
    const next = chosen.includes(n) ? chosen.filter(x => x !== n) : [...chosen, n]
    try { const r = await send(next.join(' | ')); if (r) setSt(r) } catch (e) { toast.error(e.message) }
  }
  return (
    <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <label className="flex cursor-pointer items-center gap-3">
        <input type="checkbox" checked={!!st?.on} onChange={flip} className="h-5 w-5 accent-teal-600" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">📩 Send LMIS codes to Adal Keep</span>
          <span className="block text-xs text-slate-500">LMIS's sign-in code (its SMS) goes to Adal Keep by itself. When Adal Keep's robot pressed Sign In, the code goes to it alone: it types it, signs in and carries on. When a person signed in by hand, every PC's tray shows the code to copy. Only LMIS messages are looked at.</span>
        </span>
      </label>
      {st?.on && !st.allowed && <p className="mt-2 text-xs font-semibold text-amber-700">Android has not allowed SMS yet: turn this off and on again and press Allow. No Allow shows? Android → Settings → Apps → Adal Keep → ⋮ (top right) → Allow restricted settings, then Permissions → SMS → Allow.</p>}
      {st?.on && accounts.length > 0 && (
        <div className="mt-3 border-t border-slate-200 pt-2 dark:border-slate-700">
          <p className="mb-1 text-xs font-semibold text-slate-500">The LMIS account whose number is in this phone:</p>
          {accounts.map(a => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-teal-600" checked={chosen.includes(nameOf(a))} onChange={() => pick(a)} />
              <span className="truncate">{nameOf(a)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
