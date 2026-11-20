/**
 * Settings → This phone → "Send LMIS codes to Adal Keep": LMIS sends its
 * sign-in code by SMS to the number of the LMIS account; with this on, the
 * phone app reads LMIS's SMS on this phone and passes just the code to the
 * main PC (adal-phone SmsCodeReceiver), which types it into the tab of that
 * account (backend smsCodes.js). Only LMIS messages are looked at; nothing
 * else is read, kept or sent.
 *
 * The person chooses which LMIS account(s) send their SMS to this phone (and,
 * with two, which SIM each is in). The accounts always show, on or off
 * (asked on 2026-11-20: "the phone doesn't allow me to choose the specific
 * account that the OTP is sent"): a choice made while it is off is kept and
 * used when it is turned on.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

const plugin = () => window.Capacitor?.Plugins?.AdalDiscovery
const nameOf = (a) => `${a.name || 'LMIS'}${a.phone ? ` · ${a.phone}` : ''}`
// "1:nuzla · 0911… | 2:ZAD · …" ⇄ [{ sim, n }]
const parse = (s) => String(s || '').split(' | ').filter(Boolean).map(x => { const m = /^([12]):(.*)$/.exec(x); return { sim: m ? Number(m[1]) : 0, n: m ? m[2] : x } })
const text = (list) => list.map(c => (c.sim ? `${c.sim}:` : '') + c.n).join(' | ')
const DRAFT = 'adal-sms-accounts'

export default function SmsCodesSwitch() {
  const [st, setSt] = useState(null)   // { on, allowed, account }
  const [accounts, setAccounts] = useState(null)   // null = loading
  const [why, setWhy] = useState('')
  const [draft, setDraft] = useState(() => { try { return parse(localStorage.getItem(DRAFT)) } catch { return [] } })
  const load = () => plugin()?.smsForward?.({}).then(setSt).catch(() => setSt(null))
  useEffect(() => {
    load()
    api.get('/lmis/accounts').then(r => setAccounts(Array.isArray(r.data) ? r.data : []))
      .catch(e => { setAccounts([]); setWhy(e.response?.data?.error || e.message || 'not loaded') })
  }, [])
  if (!plugin()?.smsForward) return null

  // On: what the phone keeps; off: the choice kept on this phone until it is turned on.
  const chosen = st?.on ? parse(st.account) : draft
  const has = (n) => chosen.find(c => c.n === n)
  const send = async (account) => {
    // The online-copy code (60 kB) only when this is switched: Settings on a PC never needs it.
    const { cloudCreds } = await import('../cloud/adapter.js')
    const c = cloudCreds()
    if (!c?.email) { toast.error('Pair this phone with the office PC first'); return null }
    return plugin().smsForward({ on: true, url: c.url, anon: c.anon, email: c.email, password: c.password, agency: c.agency, account })
  }
  const keep = async (next) => {
    setDraft(next)
    try { localStorage.setItem(DRAFT, text(next)) } catch {}
    if (!st?.on) return
    try { const r = await send(text(next)); if (r) setSt(r) } catch (e) { toast.error(e.message) }
  }
  const flip = async () => {
    try {
      if (st?.on) { setSt(await plugin().smsForward({ on: false })); return toast.success('LMIS codes are not sent any more') }
      const list = chosen.length ? chosen : accounts?.length === 1 ? [{ sim: 0, n: nameOf(accounts[0]) }] : []
      if (!list.length && accounts?.length > 1) return toast.error('Tick the LMIS account whose SMS comes to this phone')
      const r = await send(text(list))
      if (!r) return
      setSt(r)
      toast.success(r.allowed ? 'LMIS codes now go to Adal Keep by themselves' : 'Allow "SMS" when Android asks — then LMIS codes go to Adal Keep', { duration: 7000 })
      setTimeout(load, 4000)
    } catch (e) { toast.error(e.message) }
  }
  const pick = (a) => { const n = nameOf(a); keep(has(n) ? chosen.filter(c => c.n !== n) : [...chosen, { sim: 0, n }]) }
  // Two LMIS numbers in one phone (two SIMs): which SIM each is in, so each code goes to its own account.
  const simOf = (a, sim) => { const n = nameOf(a); keep(chosen.map(c => c.n === n ? { ...c, sim } : c)) }

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

      <div className="mt-3 border-t border-slate-200 pt-2 dark:border-slate-700">
        <p className="mb-1 text-xs font-semibold text-slate-500">Whose LMIS SMS comes to this phone?</p>
        {accounts === null && <p className="text-xs text-slate-400">…</p>}
        {accounts?.length === 0 && <p className="text-xs text-amber-700">{why ? `The LMIS accounts could not be loaded (${why}).` : 'No LMIS account yet: add one on the PC (Settings → LMIS).'}</p>}
        {(accounts || []).map(a => {
          const c = has(nameOf(a))
          return (
            <div key={a.id} className={`mt-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${c ? 'bg-teal-50 dark:bg-teal-900/30' : ''}`}>
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input type="checkbox" className="h-5 w-5 accent-teal-600" checked={!!c} onChange={() => pick(a)} />
                <span className="truncate font-medium">{nameOf(a)}</span>
              </label>
              {chosen.length > 1 && c && [1, 2].map(n => (
                <button key={n} type="button" onClick={() => simOf(a, c.sim === n ? 0 : n)}
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${c.sim === n ? 'bg-teal-600 text-white' : 'border border-slate-300 text-slate-500 dark:border-slate-600'}`}>SIM {n}</button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
