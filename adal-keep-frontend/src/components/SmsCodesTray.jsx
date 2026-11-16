/**
 * LMIS's SMS codes in the document tray of every PC (asked on 2026-11-15):
 * the agency's phone reads the code LMIS sends to the number of an LMIS
 * account and passes it to the main PC (adal-phone SmsCodeReceiver); here it
 * shows at once with a Copy button, so anyone can type it and carry on. The
 * LMIS robot still types it by itself when it is the one signing in.
 */
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import { onPhone } from '../lib/phoneMode'

const copy = async (code) => {
  try { await navigator.clipboard.writeText(code) } catch {
    const t = document.createElement('textarea'); t.value = code; document.body.appendChild(t); t.select()
    try { document.execCommand('copy') } catch {} t.remove()
  }
  toast.success(`Copied ${code}`)
}

/** The codes of the last 10 minutes; a new one also pops up with Copy. */
export function useSmsCodes() {
  const [codes, setCodes] = useState([])
  const seen = useRef(Date.now() - 60000)
  useEffect(() => {
    if (onPhone() || import.meta.env.VITE_DEMO === '1' || import.meta.env.VITE_ADMIN === '1') return
    let stop = false
    const every = window.__ADAL_CLOUD ? 15000 : 5000
    const look = async () => {
      if (stop || document.hidden) return
      try {
        const list = (await api.get('/lmis/sms-codes', { adalNoCache: true })).data
        if (!Array.isArray(list)) return
        setCodes(list)
        for (const c of list.filter(c => c.at > seen.current).reverse()) {
          toast((t) => (
            <span className="flex items-center gap-3">
              <span>📩 LMIS code{c.account ? ` (${c.account})` : ''}: <b className="font-mono text-lg tracking-widest">{c.code}</b></span>
              <button type="button" className="rounded-md bg-teal-600 px-2 py-1 text-xs font-bold text-white" onClick={() => { copy(c.code); toast.dismiss(t.id) }}>Copy</button>
            </span>
          ), { duration: 120000, id: `sms-${c.at}` })
        }
        if (list.length) seen.current = Math.max(seen.current, ...list.map(c => c.at))
      } catch {}
    }
    look()
    const id = setInterval(look, every)
    document.addEventListener('visibilitychange', look)
    return () => { stop = true; clearInterval(id); document.removeEventListener('visibilitychange', look) }
  }, [])
  return codes
}

/** The codes as the tray's first rows. */
export function SmsCodesRows({ codes }) {
  if (!codes?.length) return null
  return (
    <div className="border-b border-slate-200/60 p-2 dark:border-slate-800/60">
      <div className="px-1 pb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">LMIS codes (SMS)</div>
      {codes.map(c => (
        <div key={c.at} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-100/80 dark:hover:bg-white/10">
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-base font-bold tracking-widest text-slate-800 dark:text-white">{c.code}</span>
            <span className="block truncate text-[11px] text-slate-400">{c.account || 'LMIS'} · {new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{c.used ? ' · typed by the robot' : ''}</span>
          </span>
          <button type="button" onClick={() => copy(c.code)} className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-teal-700">Copy</button>
        </div>
      ))}
    </div>
  )
}
