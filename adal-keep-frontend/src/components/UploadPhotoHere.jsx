/**
 * Make a CV → "Upload a Photo / Full Body Photo": taken with the phone's
 * camera (or picked) right here, and filed on her profile — no going back to
 * the profile page. With the office PC off it is filed when the PC is on.
 */
import { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

const err = (e) => e?.response?.data?.error || e.message

export default function UploadPhotoHere({ profileId, field, onDone }) {
  const pick = useRef(null)
  const [busy, setBusy] = useState(false)
  const send = async (file) => {
    if (!file) return
    setBusy(true)
    try {
      // Opening her fields makes the ones she does not have yet.
      const fields = (await api.get(`/profiles/${profileId}/fields`, { adalNoCache: true })).data || []
      const f = fields.find(x => x.name === field)
      if (!f) throw new Error(`Her profile has no "${field}" box`)
      const form = new FormData()
      form.append('file', file)
      const { data } = await api.post(`/profiles/${profileId}/fields/${f.id}/upload`, form, { headers: { 'Content-Type': 'multipart/form-data' } })
      toast.success(data?.queued ? `${field} saved — the PC files it when it is on` : `${field} saved`)
      onDone?.(field)
    } catch (e) { toast.error(err(e)) }
    setBusy(false)
    if (pick.current) pick.current.value = ''
  }
  return (
    <div className="mt-3">
      <input ref={pick} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => send(e.target.files?.[0])} />
      <button type="button" disabled={busy} onClick={() => pick.current?.click()}
        className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {busy ? 'Saving…' : `📷 Take or pick her ${field}`}
      </button>
    </div>
  )
}
