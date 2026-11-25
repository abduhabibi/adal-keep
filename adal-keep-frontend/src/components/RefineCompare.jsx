import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import api from '../services/api'

/**
 * Refine, faithful: the picture is cleaned and made bigger — nothing about her changes — and shown
 * next to the original before anything is kept (backend services/faithfulRefine.js, routes/refineCompare.js).
 * The original always stays. Only a click starts it. Her photo does not leave this PC.
 */
const SIZES = [
  ['original', 'Same size', 'Cleans blocks and colour blotches; adds no pixels.'],
  ['2k', '2K (2048 px)', 'Enlarged smoothly. Adds pixels, not new detail.'],
  ['4k', '4K (3840 px)', 'Enlarged more. Adds pixels, not new detail: a small photo stays a small photo, only smoother.'],
]

export default function RefineCompare({ file, fieldName, onClose, onKept }) {
  const [size, setSize] = useState('original')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)       // { token, width, height, bytes, from }
  const [err, setErr] = useState('')

  useEffect(() => () => {}, [])
  const run = async () => {
    setBusy(true); setErr(''); setRes(null)
    try { setRes((await api.post(`/photo-refine/${file.id}/preview`, { size }, { timeout: 300000 })).data) }
    catch (e) { setErr(e.response?.data?.error || 'Refine failed') }
    setBusy(false)
  }
  const keep = async () => {
    setBusy(true)
    try { await api.post(`/photo-refine/preview/${res.token}/keep`); toast.success('Kept — the original is still below'); onKept?.(); onClose() }
    catch (e) { setErr(e.response?.data?.error || 'Could not save') }
    setBusy(false)
  }
  const kb = (n) => `${Math.round(n / 1024)} KB`
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3" role="dialog" aria-label="Refine">
      <div className="max-h-[94vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">Refine — {fieldName}</h2>
          <button type="button" onClick={onClose} className="text-xl leading-none text-slate-500" aria-label="Close">×</button>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300">Cleans the picture and keeps her exactly as she is: no new face, no lighter skin, no change of shape. The original stays. Her photo does not leave this PC.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {SIZES.map(([k, label, note]) => (
            <label key={k} className={`cursor-pointer rounded-xl border p-3 text-sm ${size === k ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-300 dark:border-slate-600'}`}>
              <input type="radio" className="mr-2" checked={size === k} onChange={() => setSize(k)} />
              <b>{label}</b><span className="mt-1 block text-xs text-slate-500">{note}</span>
            </label>
          ))}
        </div>
        {err && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{err}</p>}
        {res && (
          <div className="space-y-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <figure><img src={`/api/files/${file.id}/download`} alt="Before" className="w-full rounded-lg object-contain max-h-[55vh]" /><figcaption className="mt-1 text-center text-xs text-slate-500">Before — {res.from.width}×{res.from.height}</figcaption></figure>
              <figure><img src={`/api/photo-refine/preview/${res.token}`} alt="After" className="w-full rounded-lg object-contain max-h-[55vh]" /><figcaption className="mt-1 text-center text-xs text-slate-500">After — {res.width}×{res.height}, {kb(res.bytes)}</figcaption></figure>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={run} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy && !res ? 'Refining…' : res ? 'Refine again' : 'Refine'}</button>
          {res && <button type="button" disabled={busy} onClick={keep} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Keep the refined picture</button>}
          <button type="button" onClick={onClose} className="ml-auto rounded-lg border px-4 py-2 text-sm">Close</button>
        </div>
      </div>
    </div>, document.body)
}
