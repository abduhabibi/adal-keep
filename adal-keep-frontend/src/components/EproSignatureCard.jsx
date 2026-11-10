/**
 * Settings → Integrations → EPRO signature: the agency's signed contract,
 * uploaded once. The EPRO robot puts it in Musaned's Contract Upload after
 * pressing APPROVE (it never presses SAVE).
 */
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const err = (e) => e?.response?.data?.error || e.message

export default function EproSignatureCard() {
  const [sig, setSig] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const input = useRef(null)
  const load = () => api.get('/musaned/epro-signature').then(r => setSig(r.data || null)).catch(() => setSig(null))
  useEffect(() => { load() }, [])
  const send = async (file) => {
    if (!file) return
    setBusy(true)
    try {
      const body = new FormData(); body.append('file', file)
      await api.post('/musaned/epro-signature', body, { headers: { 'Content-Type': 'multipart/form-data' } })
      toast.success('Signed contract saved — the EPRO robot uses it'); load()
    } catch (e) { toast.error(err(e)) }
    setBusy(false)
  }
  const remove = async () => {
    if (!window.confirm('Remove the signed contract? EPRO approve cannot run without it.')) return
    await api.delete('/musaned/epro-signature').catch(() => {}); load()
  }
  if (sig === undefined) return null
  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2"><span>✍️</span> EPRO signature</h2>
      <p className="text-sm text-slate-500 mb-3">The signed contract for Musaned's Contract Upload. Uploaded once: after Wafid FIT, <b>EPRO approve</b> presses APPROVE and uploads it — you look it over and press SAVE yourself.</p>
      <div className="flex flex-wrap items-center gap-2">
        {sig
          ? <span className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-800 dark:bg-emerald-900/20">📄 <b>{sig.name}</b> <span className="text-xs text-slate-500">· {Math.round(sig.size / 1024)} KB</span></span>
          : <span className="text-sm text-amber-700 dark:text-amber-300">No signed contract yet.</span>}
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Saving…' : sig ? 'Replace' : '📁 Choose the signed contract'}</Button>
        {sig && <button type="button" onClick={remove} className="text-xs text-red-600 hover:underline">Remove</button>}
        <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; send(f) }} />
      </div>
      <p className="mt-2 text-xs text-slate-500">PDF, PNG or JPG, up to 5 MB (Musaned's limits).</p>
    </Card>
  )
}
