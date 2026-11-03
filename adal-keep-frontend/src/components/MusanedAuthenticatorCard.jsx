/**
 * Settings → Portals → Musaned authenticator: per Musaned account, the QR code
 * the authenticator app was set up with — dropped here or chosen from the
 * files (a picture or screenshot), or the key typed. Adal Keep then types
 * Musaned's 6-digit code itself; with the reCAPTCHA passing by itself, the
 * sign-in needs nobody. The key stays locked on this PC.
 */
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const err = (e) => e?.response?.data?.error || e.message

function Account({ a, has, onChange }) {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState('')
  const input = useRef(null)
  const send = async (file, text = '') => {
    setBusy(true)
    try {
      const body = new FormData()
      if (file) body.append('image', file); else body.append('key', text)
      const { data } = await api.post(`/musaned/accounts/${a.id}/authenticator`, body, { headers: { 'Content-Type': 'multipart/form-data' } })
      toast.success(`${a.name}: authenticator saved${data.label ? ` (${data.label})` : ''} — the code now is ${data.code}; it should match your app`, { duration: 10000 })
      setKey(''); onChange()
    } catch (e) { toast.error(err(e), { duration: 8000 }) }
    setBusy(false)
  }
  const remove = async () => {
    if (!confirm(`Remove the authenticator of ${a.name}? Musaned codes are then typed by a person again.`)) return
    try { await api.delete(`/musaned/accounts/${a.id}/authenticator`); onChange() } catch (e) { toast.error(err(e)) }
  }
  return (
    <li className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">{a.name} <span className="font-normal text-slate-400">{a.username}</span></span>
        {has
          ? <span className="flex shrink-0 items-center gap-2 text-xs"><span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">🔑 Code typed by Adal Keep</span><button type="button" onClick={remove} className="text-red-600 hover:underline">Remove</button></span>
          : <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800">A person types the code</span>}
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) send(f) }}
        onPaste={(e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) send(f) }}
        className={`mt-2 flex flex-wrap items-center gap-2 rounded-lg border-2 border-dashed p-3 text-xs transition ${over ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700'}`}>
        <span className="text-slate-500">{busy ? 'Reading…' : <>Drop the authenticator <b>QR picture</b> here, or</>}</span>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>📁 Choose from files</Button>
        <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) send(f) }} />
        <span className="text-slate-400">or the key:</span>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="JBSW Y3DP EHPK 3PXP…" autoComplete="off"
          className="min-w-[10rem] flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-800" />
        <Button size="sm" disabled={busy || key.trim().length < 16} onClick={() => send(null, key)}>Save</Button>
      </div>
    </li>
  )
}

export default function MusanedAuthenticatorCard() {
  const [accounts, setAccounts] = useState(null)
  const [has, setHas] = useState({})
  const load = () => {
    api.get('/musaned/accounts').then(r => setAccounts(r.data || [])).catch(() => setAccounts([]))
    api.get('/musaned/authenticators').then(r => setHas(r.data || {})).catch(() => {})
  }
  useEffect(() => { load() }, [])
  if (!accounts) return null
  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>🔑</span> Musaned authenticator</h2>
      <p className="text-sm text-slate-500 mb-3" translate="no">
        Give Adal Keep the QR code your authenticator app was set up with (when Musaned showed it, or a screenshot of it) and Adal Keep types Musaned's 6-digit code itself.
        When the “I'm not a robot” box passes by itself, signing in to Musaned then needs nobody. The key is kept locked on this PC only.
      </p>
      {accounts.length
        ? <ul className="space-y-2">{accounts.map(a => <Account key={a.id} a={a} has={!!has[a.id]} onChange={load} />)}</ul>
        : <p className="text-sm text-slate-400">No Musaned account yet — add one in a profile's AI actions (Musaned).</p>}
    </Card>
  )
}
