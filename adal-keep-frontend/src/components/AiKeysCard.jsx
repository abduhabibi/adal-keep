/**
 * Settings → Photo refining keys: the agency pastes Google AI Studio keys
 * (aistudio.google.com → Get API key) with the Google account each belongs to.
 * Kept locked on this PC; this card only ever sees the account and the last
 * 4 characters. Each key is checked with Google: picture editing needs billing
 * on that Google account (the free plan edits no pictures).
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import { isPhoneApp } from '../lib/phoneMode'

const SAID = {
  ok: ['✅ can refine photos', 'text-emerald-600'],
  'needs-billing': ['⚠ needs billing on this Google account (free plan edits no pictures)', 'text-amber-600'],
  refused: ['✗ Google refused this key', 'text-red-600'],
  unchecked: ['… not checked yet', 'text-slate-400'],
}
const err = (e) => e?.response?.data?.error || e.message

export default function AiKeysCard() {
  // Kept on the office PC only: a phone does not manage them.
  if (isPhoneApp()) return null
  return <Keys />
}

function Keys() {
  const [keys, setKeys] = useState(null)
  const [email, setEmail] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState('')
  const load = () => api.get('/system/ai-keys', { adalNoCache: true }).then(r => setKeys(r.data || [])).catch(() => setKeys([]))
  useEffect(() => { load() }, [])

  const add = async () => {
    if (!key.trim()) return toast.error('Paste the key from Google AI Studio')
    setBusy('add')
    try { setKeys((await api.post('/system/ai-keys', { email, key })).data); setKey(''); setEmail(''); toast.success('Key saved and checked') }
    catch (e) { toast.error(err(e)) }
    setBusy('')
  }
  const check = async (id) => { setBusy(id); try { setKeys((await api.post(`/system/ai-keys/${id}/check`)).data) } catch (e) { toast.error(err(e)) } setBusy('') }
  const remove = async (id) => { if (!window.confirm('Remove this key?')) return; try { setKeys((await api.delete(`/system/ai-keys/${id}`)).data) } catch (e) { toast.error(err(e)) } }

  return (
    <Card>
      <h3 className="mb-2 font-display text-lg font-bold text-slate-900 dark:text-white">🪄 Photo refining keys (Google AI Studio)</h3>
      <p className="text-xs text-slate-500 mb-3">
        Open <a className="text-teal-600 underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a> with
        the agency's Google account, press <b>Create API key</b>, and paste it here. Refine uses these keys, the most capable picture model first.
        Picture editing needs billing turned on for that Google account.
      </p>
      <div className="flex flex-wrap gap-2">
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Google account (email)" type="email"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
        <input value={key} onChange={e => setKey(e.target.value)} placeholder="API key (AIza…)" type="password" autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
        <button type="button" onClick={add} disabled={busy === 'add'} className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy === 'add' ? 'Checking…' : 'Save key'}
        </button>
      </div>
      <ul className="mt-3 space-y-1.5">
        {keys === null && <li className="text-xs text-slate-400">Loading…</li>}
        {keys?.length === 0 && <li className="text-xs text-slate-400">No key yet.</li>}
        {(keys || []).map(k => {
          const [text, color] = SAID[k.status] || SAID.unchecked
          return (
            <li key={k.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700">
              <span className="font-medium">{k.email || 'Google account'}</span>
              <span className="text-xs text-slate-400">…{k.ends}</span>
              <span className={`text-xs ${color}`}>{text}</span>
              <span className="ml-auto flex gap-2">
                <button type="button" onClick={() => check(k.id)} disabled={busy === k.id} className="text-xs text-teal-600 hover:underline disabled:opacity-50">{busy === k.id ? 'Checking…' : 'Check'}</button>
                <button type="button" onClick={() => remove(k.id)} className="text-xs text-red-600 hover:underline">Remove</button>
              </span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
