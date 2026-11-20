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
  // Ticked accounts, each with the SIM its number is in (0 = not said): "1:nuzla · 0911… | 2:ZAD · …".
  const chosen = String(st?.account || '').split(' | ').filter(Boolean).map(x => { const m = /^([12]):(.*)$/.exec(x); return { sim: m ? Number(m[1]) : 0, n: m ? m[2] : x } })
  const has = (n) => chosen.find(c => c.n === n)
  const text = (list) => list.map(c => (c.sim ? `${c.sim}:` : '') + c.n).join(' | ')
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
      const r = await send(chosen.length ? text(chosen) : accounts.length === 1 ? nameOf(accounts[0]) : '')
      if (!r) return
      setSt(r)
      toast.success(r.allowed ? 'LMIS codes now go to Adal Keep by themselves' : 'Allow "SMS" when Android asks — then LMIS codes go to Adal Keep', { duration: 7000 })
      setTimeout(load, 4000)
    } catch (e) { toast.error(e.message) }
  }
  const save = async (next) => { try { const r = await send(text(next)); if (r) setSt(r) } catch (e) { toast.error(e.message) } }
  const pick = (a) => { const n = nameOf(a); save(has(n) ? chosen.filter(c => c.n !== n) : [...chosen, { sim: 0, n }]) }
  // Two LMIS numbers in one phone (two SIMs): which SIM each is, so each code goes to its own account.
  const simOf = (a, sim) => { const n = nameOf(a); save(chosen.map(c => c.n === n ? { ...c, sim } : c)) }
  return (
    <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <label className="flex cursor-pointer items-center gap-3">
        <input type="checkbox" checked={!!st?.on} onChange={flip} className="h-5 w-5 accent-teal-600" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">📩 Send LMIS codes to Adal Keep</span>
          <span className="block text-xs text-slate-500">LMIS's code is typed in by itself, on the PC that pressed Sign In. Only LMIS messages are read.</span>
        </span>
      </label>
      {st?.on && !st.allowed && <p className="mt-2 text-xs font-semibold text-amber-700">Android has not allowed SMS yet: turn this off and on again and press Allow. No Allow shows? Android → Settings → Apps → Adal Keep → ⋮ (top right) → Allow restricted settings, then Permissions → SMS → Allow.</p>}
      {st?.on && accounts.length > 0 && (
        <div className="mt-3 border-t border-slate-200 pt-2 dark:border-slate-700">
          <p className="mb-1 text-xs font-semibold text-slate-500">The LMIS account whose number is in this phone:</p>
          {accounts.map(a => (
            <div key={a.id} className="flex items-center gap-2 py-1 text-sm">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-teal-600" checked={!!has(nameOf(a))} onChange={() => pick(a)} />
                <span className="truncate">{nameOf(a)}</span>
              </label>
              {chosen.length > 1 && has(nameOf(a)) && [1, 2].map(n => (
                <button key={n} type="button" onClick={() => simOf(a, has(nameOf(a)).sim === n ? 0 : n)}
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${has(nameOf(a)).sim === n ? 'bg-teal-600 text-white' : 'border border-slate-300 text-slate-500 dark:border-slate-600'}`}>SIM {n}</button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
