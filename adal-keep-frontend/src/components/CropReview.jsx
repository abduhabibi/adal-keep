/**
 * "Check the crop" (asked on 2026-11-20: after a photo is uploaded that has to
 * be cut, a person sees the crop before it is used). JEV cut one picture into
 * her photo, full body photo and passport (backend services/placement.js);
 * nothing goes into her boxes until a person presses Save here. Each part can
 * be left out or framed again by hand from the whole picture.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import FullBodyCropper from './FullBodyCropper'

// The frame each part is cut to when framed again by hand.
const SHAPE = {
  photo: { ratio: 3 / 4, outW: 900, outH: 1200, title: 'Frame the photo', guides: false },
  fullbody: { ratio: 1 / 3, outW: 600, outH: 1800, title: 'Frame the full body photo', guides: true },
  passport: { ratio: 125 / 88, outW: 1500, outH: 1056, title: 'Frame the passport page', guides: false },
}

export default function CropReview({ profileId, onSaved }) {
  const [list, setList] = useState([])
  const [use, setUse] = useState({})          // kind → true/false
  const [framed, setFramed] = useState({})    // kind → File framed by hand
  const [editing, setEditing] = useState(null) // { kind, file }
  const [busy, setBusy] = useState(false)
  const r = list[0]

  const load = useCallback(() => {
    if (!profileId) return
    api.get(`/profiles/${profileId}/crop-reviews`, { adalNoCache: true })
      .then(res => setList(Array.isArray(res.data) ? res.data : [])).catch(() => {})
  }, [profileId])
  useEffect(() => { load() }, [load])
  useEffect(() => onDataChange(['crop_reviews'], load, 500), [load])
  // A new question: every part is used until the person says otherwise.
  useEffect(() => {
    setUse(Object.fromEntries((r?.parts || []).map(p => [p.kind, true])))
    setFramed({})
  }, [r?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!r) return null
  const src = (kind) => framed[kind] ? URL.createObjectURL(framed[kind]) : `/api/crop-reviews/${r.id}/image/${kind}`

  const adjust = async (kind) => {
    try {
      const res = await api.get(`/crop-reviews/${r.id}/image/original`, { responseType: 'blob', adalNoCache: true })
      setEditing({ kind, file: new File([res.data], 'picture.jpg', { type: res.data.type || 'image/jpeg' }) })
    } catch { toast.error('The picture could not be opened') }
  }
  const answer = async (keep) => {
    setBusy(true)
    try {
      const form = new FormData()
      const chosen = keep ? r.parts.map(p => p.kind).filter(k => use[k]) : []
      form.append('use', JSON.stringify(chosen))
      for (const k of chosen) if (framed[k]) form.append(k, framed[k])
      const res = await api.post(`/crop-reviews/${r.id}`, form)
      const done = res.data?.done || []
      toast.success(done.length ? `Saved: ${done.join(', ')}` : 'Kept as it was')
      setList(l => l.slice(1))
      onSaved?.()
      load()
    } catch (e) { toast.error(e.response?.data?.error || 'Not saved') }
    finally { setBusy(false) }
  }

  return createPortal(
    <div className="fixed inset-0 z-[99990] flex items-center justify-center bg-slate-950/70 p-3 sm:p-6">
      <div className="max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl dark:bg-slate-900 sm:p-6">
        <div className="flex items-start gap-3">
          <img src={`/api/crop-reviews/${r.id}/image/original`} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover ring-1 ring-slate-200 dark:ring-slate-700" />
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Check the crop</h2>
            <p className="text-sm text-slate-500">Nothing is saved until you press Save.</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {r.parts.map(p => (
            <div key={p.kind} className={`flex flex-col rounded-xl border p-2 ${use[p.kind] ? 'border-teal-500 ring-1 ring-teal-500' : 'border-slate-200 dark:border-slate-700'}`}>
              <div className={`flex h-48 items-center justify-center overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800 sm:h-56 ${use[p.kind] ? '' : 'opacity-30 grayscale'}`}>
                <img src={src(p.kind)} alt={p.box} className="max-h-full max-w-full object-contain" />
              </div>
              <div className="mt-2 text-sm font-semibold text-slate-800 dark:text-slate-100">{p.box}</div>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => setUse(u => ({ ...u, [p.kind]: !u[p.kind] }))}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold ${use[p.kind] ? 'bg-teal-600 text-white' : 'border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300'}`}>
                  {use[p.kind] ? '✓ Use' : 'Skip'}
                </button>
                <button type="button" onClick={() => adjust(p.kind)}
                  className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">
                  ✂ Adjust
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" disabled={busy || !r.parts.some(p => use[p.kind])} onClick={() => answer(true)}
            className="rounded-xl bg-teal-600 px-5 py-3 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">Save</button>
          <button type="button" disabled={busy} onClick={() => answer(false)}
            className="rounded-xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200">Keep as it was</button>
        </div>
      </div>

      {editing && (
        <FullBodyCropper file={editing.file} {...SHAPE[editing.kind]} keepLabel={null}
          onCancel={() => setEditing(null)}
          onDone={(f) => { setFramed(x => ({ ...x, [editing.kind]: f })); setUse(u => ({ ...u, [editing.kind]: true })); setEditing(null) }} />
      )}
    </div>,
    document.body,
  )
}
