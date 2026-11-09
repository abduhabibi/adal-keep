/**
 * A WhatsApp message to every picked profile, each from the person's own
 * WhatsApp: to her phone or her broker's. Typed (with {name} and
 * {selected_by} — the office that selected her) or a voice note recorded here.
 */
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { wa } from '../lib/whatsapp'

const err = (e) => e?.response?.data?.error || e.message
const DEFAULT = 'Hello {name}, you have been selected by {selected_by}. Please come to the office.'
const voiceType = () => ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'].find(t => window.MediaRecorder?.isTypeSupported?.(t)) || ''

export default function WhatsAppNotice({ picked, onClose }) {
  const [to, setTo] = useState('her')
  const [text, setText] = useState(DEFAULT)
  const [rec, setRec] = useState(null)        // the recorder while recording
  const [voice, setVoice] = useState(null)    // { url, data, mime, secs }
  const [job, setJob] = useState(null)
  const started = useRef(0)

  // How far the sending is.
  useEffect(() => {
    if (!job?.running) return
    const t = setInterval(async () => {
      try {
        const { data } = await wa.get('/whatsapp/notify')
        setJob(data)
        if (!data.running) toast[data.failed ? 'error' : 'success'](`WhatsApp: sent to ${data.sent} of ${data.total}${data.failed ? ` — ${data.failed} not sent` : ''}`, { duration: 8000 })
      } catch {}
    }, 2000)
    return () => clearInterval(t)
  }, [job?.running])

  const record = async () => {
    if (rec) { rec.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = voiceType()
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const parts = []
      r.ondataavailable = (e) => e.data.size && parts.push(e.data)
      r.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(parts, { type: r.mimeType || mime || 'audio/webm' })
        const fr = new FileReader()
        fr.onload = () => setVoice({ url: URL.createObjectURL(blob), data: String(fr.result), mime: blob.type, secs: Math.round((Date.now() - started.current) / 1000) })
        fr.readAsDataURL(blob)
        setRec(null)
      }
      started.current = Date.now()
      r.start()
      setRec(r)
    } catch (e) { toast.error(`The microphone could not be used: ${e.message}`) }
  }

  const send = async () => {
    try {
      const { data } = await wa.post('/whatsapp/notify', { profile_ids: picked.map(p => p.id), to, text, audio: voice ? { data: voice.data, mime: voice.mime } : null })
      setJob(data)
      toast.success(`Sending to ${picked.length} on WhatsApp…`)
    } catch (e) { toast.error(err(e)) }
  }

  const example = picked[0] ? text.replace(/\{name\}/gi, picked[0].full_name || '').replace(/\{selected_by\}/gi, picked[0].musaned_pro || picked[0].employer_name || '—').replace(/\{passport\}/gi, picked[0].passport_number || '') : ''

  return (
    <div className="col-span-2 space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/50 p-2 dark:border-emerald-800 dark:bg-emerald-900/20 lg:col-span-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300">💬 WhatsApp to {picked.length}</span>
        <button type="button" onClick={onClose} className="rounded px-1.5 text-slate-400 hover:text-slate-600">✕</button>
      </div>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-white p-0.5 text-xs font-semibold dark:bg-slate-900">
        {[['her', 'Her phone'], ['broker', 'Her broker']].map(([k, t]) => (
          <button key={k} type="button" onClick={() => setTo(k)} className={`rounded-md py-1 ${to === k ? 'bg-emerald-600 text-white' : 'text-slate-500'}`}>{t}</button>
        ))}
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={3}
        className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900" />
      <p className="text-[10px] leading-tight text-slate-500">{'{name}'} · {'{selected_by}'} (who selected her) · {'{passport}'}{example && <><br />e.g. “{example.slice(0, 120)}”</>}</p>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={record}
          className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${rec ? 'animate-pulse bg-red-600 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-600'}`}>
          {rec ? '■ Stop' : voice ? '🎤 Again' : '🎤 Voice'}
        </button>
        {voice && !rec && <audio src={voice.url} controls className="h-8 min-w-0 flex-1" />}
        {voice && !rec && <button type="button" onClick={() => setVoice(null)} className="shrink-0 text-xs text-slate-400 hover:text-red-600" title="Drop the voice note">✕</button>}
      </div>
      <button type="button" onClick={send} disabled={job?.running || !!rec || (!text.trim() && !voice)}
        className="w-full rounded-lg bg-emerald-600 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
        {job?.running ? `Sending ${job.done} of ${job.total}…` : `Send to ${picked.length}`}
      </button>
      {job && !job.running && job.errors?.length > 0 && (
        <ul className="max-h-24 overflow-y-auto text-[11px] text-red-600 dark:text-red-400">{job.errors.slice(0, 20).map((e, i) => <li key={i}>✗ {e}</li>)}</ul>
      )}
    </div>
  )
}
