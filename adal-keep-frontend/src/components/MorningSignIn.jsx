/**
 * Dashboard → Morning sign-in: every site the robots use, signed in or not.
 * Sign in to each once in the morning: Adal Keep keeps them signed in all day
 * (services/sessionKeeper.js) and the robots go straight to work there.
 * Tasheer has one sign-in for the whole agency: every PC sees who signed it
 * in, and "Sign in here" takes it over — its tab opens here, live, with the
 * name and password filled; the person types the captcha.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import LiveTab from './LiveTab'

// Each site's list of saved accounts (AI Actions): the visa platform's is /visa/accounts.
const ACCOUNT_LIST = { mofa: 'visa' }
const err = (e) => e?.response?.data?.error || e.message
const when = (iso) => { try { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

// What this device saw last: the card draws at once, then the PC's answer fills it in.
const CACHE = 'ak-morning-sites'
const cached = () => { try { const v = JSON.parse(localStorage.getItem(CACHE)); return Array.isArray(v) ? v : null } catch { return null } }

export default function MorningSignIn() {
  const [sites, setSitesNow] = useState(cached)
  const setSites = (v) => { setSitesNow(v); try { if (v.length) localStorage.setItem(CACHE, JSON.stringify(v)) } catch {} }
  const [live, setLive] = useState(null)
  const [choose, setChoose] = useState(null)   // { site, accounts } while the person picks the account
  const load = () => api.get('/sessions').then(r => setSites(Array.isArray(r.data) ? r.data : [])).catch(() => setSitesNow(s => s || []))
  // Asked again after 3 s (the PC looks at its tabs behind its first answer), then every 15 s.
  useEffect(() => { load(); const s = setTimeout(load, 3000); const t = setInterval(load, 15000); return () => { clearTimeout(s); clearInterval(t) } }, [])
  if (sites == null) return (
    <div className="panel p-4" aria-hidden="true">
      <span className="ak-skel mb-3 block h-5 w-40" />
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
        {[0, 1, 2, 3].map(i => <span key={i} className="ak-skel block h-12" />)}
      </div>
    </div>
  )
  if (!sites.length) return null
  // Sign in: with several accounts for the site, the person chooses which one first.
  const start = async (s) => {
    if (s.shared && s.signedIn && s.holder?.by && !confirm(`${s.name} is signed in by ${s.holder.by} (${s.holder.pc}). Tasheer allows one sign-in for the agency: sign in as you instead? Their sign-in ends.`)) return
    let accounts = []
    try { accounts = (await api.get(`/${ACCOUNT_LIST[s.key] || s.key}/accounts`)).data || [] } catch {}
    if (accounts.length > 1) return setChoose({ site: s, accounts })
    open(s, accounts[0]?.id)
  }
  const open = async (s, accountId) => {
    setChoose(null)
    try {
      const { data } = await api.post(`/sessions/${s.key}/open`, accountId ? { account_id: accountId } : {})
      if (data?.already) toast.success(`${s.name} is signed in already — its tab is used, nothing more to do`, { duration: 6000 })
      else if (data?.live) {
        setLive(data.live)
        const what = s.key === 'musaned' ? 'tick "I\'m not a robot" here — Adal Keep presses Sign in, types the code and goes on'
          : s.key === 'lmis' ? 'type the SMS code here' : s.key === 'mofa' ? 'type the picture\'s numbers here and press Login' : 'type the captcha and sign in, here'
        toast.success(`${s.name}: the name and password are filled — ${what}`, { duration: 8000 })
      } else toast.success(`Sign in to ${s.name} in the window that opened — it then stays signed in all day`, { duration: 7000 })
    } catch (e) { toast.error(err(e)) }
    setTimeout(load, 8000)
  }
  const inCount = sites.filter(s => s.signedIn).length
  return (
    <div className="panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="ak-card-title">Morning sign-in <span className="ml-1 text-sm font-normal text-slate-500 tabular-nums">{inCount}/{sites.length}</span></p>
      </div>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
        {sites.map(s => (
          // The site's name on its own line (never squeezed); its accounts or button under it.
          <div key={s.key} className={`rounded-xl border px-3 py-2 ${s.signedIn ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-900/10' : 'border-slate-200 dark:border-slate-700'}`}>
            <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.signedIn ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold leading-snug">{s.name}</span>
              {s.shared && s.holder?.by && (
                <span className="block text-[11px] text-slate-500" title={`${s.holder.by} · ${s.holder.pc} · ${when(s.holder.at)}`}>
                  {s.holder.state === 'signing-in' && !s.signedIn ? 'signing in: ' : s.signedIn ? 'by ' : 'last: '}{s.holder.by} · {when(s.holder.at)}
                </span>
              )}
            </span>
            {!(s.accounts?.length > 1) && (s.signedIn && !s.shared
              ? <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Signed in</span>
              : <button type="button" onClick={() => start(s)} title={s.shared ? 'One sign-in for the agency: this takes it over for you' : ''}
                  className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold ${s.shared && s.signedIn ? 'border border-teal-600 text-teal-700 hover:bg-teal-50 dark:text-teal-300' : 'bg-teal-600 text-white hover:bg-teal-700'}`}>
                  {s.shared && s.signedIn ? 'Sign in here' : 'Sign in'}
                </button>)}
            </div>
            {s.accounts?.length > 1 && (
              // Several accounts: each one apart, in a browser space of its own — signing in as one never signs the other out.
              <div className="mt-1.5 space-y-1 pl-[1.125rem]">
                  {s.accounts.map(a => (
                    <div key={a.id} className="flex items-center gap-1.5 text-xs">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${a.signedIn ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
                      <span className="min-w-0 flex-1" title={a.main ? "Main account (the browser's own window)" : 'Its own browser window'}>{a.name}</span>
                      {a.signedIn
                        ? <span className="font-semibold text-emerald-700 dark:text-emerald-300">✓</span>
                        : <button type="button" onClick={() => open(s, a.id)} className="shrink-0 rounded-md bg-teal-600 px-2 py-0.5 font-semibold text-white hover:bg-teal-700">Sign in</button>}
                    </div>
                  ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {choose && createPortal(
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/30 sm:items-center" onClick={() => setChoose(null)}>
          <div onClick={e => e.stopPropagation()} className="solid-sheet w-full max-w-sm space-y-2 rounded-t-2xl border border-slate-200 p-4 shadow-2xl dark:border-slate-700 sm:rounded-2xl"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
            <p className="font-bold">Sign in to {choose.site.name} as…</p>
            {choose.accounts.map(a => (
              <button key={a.id} type="button" onClick={() => open(choose.site, a.id)}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-left hover:border-teal-400 hover:bg-teal-50 dark:border-slate-700 dark:hover:bg-teal-900/20">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{a.name || a.username || a.login_value}</span>
                  <span className="block truncate text-xs text-slate-500">{a.username || a.login_value || a.phone || ''}</span>
                </span>
                {a.is_default ? <span className="shrink-0 rounded bg-teal-100 px-1.5 text-[10px] font-semibold text-teal-800 dark:bg-teal-900/40 dark:text-teal-200">default</span> : null}
              </button>
            ))}
            <button type="button" onClick={() => setChoose(null)} className="w-full rounded-lg py-2 text-sm text-slate-500">Cancel</button>
          </div>
        </div>, document.body)}
      {live && createPortal(<LiveTab runId={live} startFull onClose={() => { setLive(null); load() }} />, document.body)}
    </div>
  )
}
