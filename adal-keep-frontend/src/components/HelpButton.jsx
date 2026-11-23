import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import api from '../services/api'

/**
 * "Help" on every page (PC and phone): a short note and, if wanted, a picture
 * of the screen go to Adal support as a ticket, with this PC's logs, version and
 * PC attached by itself (backend services/tower.js). Adal's answer comes back as
 * a notification and shows here. Only where Adal opened the control tower.
 */
const STATUS = { open: 'Waiting for Adal', answered: 'Answered', closed: 'Closed' }

// A picture made small enough to send (longest side 1600 px, JPEG).
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/jpeg', 0.8))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a picture.')) }
    img.src = url
  })
}

// One picture of the screen (the browser asks which screen or window first).
async function captureScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  try {
    const v = document.createElement('video')
    v.srcObject = stream; v.muted = true
    await v.play()
    await new Promise(r => setTimeout(r, 300))
    const c = document.createElement('canvas')
    const k = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight))
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k)
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.8)
  } finally { stream.getTracks().forEach(t => t.stop()) }
}

export default function HelpButton({ phone = false }) {
  const { pathname } = useLocation()
  const [on, setOn] = useState(false)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [image, setImage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [tickets, setTickets] = useState([])
  const fileRef = useRef(null)

  useEffect(() => {
    let stop = false
    const look = () => api.get('/tower/status', { params: { short: 1 } }).then(r => { if (!stop) setOn(!!r.data?.on) }).catch(() => {})
    look()
    const t = setInterval(look, 10 * 60000)
    return () => { stop = true; clearInterval(t) }
  }, [])
  useEffect(() => {
    if (!open) return
    api.get('/tower/tickets').then(r => setTickets(r.data?.tickets || [])).catch(() => {})
  }, [open])

  if (!on) return null

  const pick = async (file) => {
    if (!file) return
    try { setImage(await shrink(file)) } catch (e) { setMsg({ bad: true, text: e.message }) }
  }
  const send = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await api.post('/tower/ticket', { text, image, page: pathname })
      setMsg({ text: r.data?.message || 'Sent.' }); setText(''); setImage(null)
      api.get('/tower/tickets').then(x => setTickets(x.data?.tickets || [])).catch(() => {})
    } catch (e) { setMsg({ bad: true, text: e.response?.data?.error || e.message }) }
    finally { setBusy(false) }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="Help — ask Adal support"
        className="fixed z-40 flex items-center gap-1.5 rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg hover:bg-indigo-700"
        style={phone ? { right: 12, bottom: 'calc(70px + env(safe-area-inset-bottom))' } : { right: 12, bottom: 52 }}>
        ? Help
      </button>
      {open && (
        <div className="fixed inset-0 z-[9995] flex items-end sm:items-center justify-center bg-black/40" onClick={() => setOpen(false)}>
          <div className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-gray-900 p-4 shadow-xl text-sm"
            onClick={e => e.stopPropagation()}
            onPaste={e => { const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/')); if (f) pick(f) }}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-base font-semibold">Help — ask Adal support</h2>
              <button type="button" className="text-gray-500 px-2" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Write what is wrong. This PC's version and recent logs go with it (no passwords).</p>
            <textarea value={text} onChange={e => setText(e.target.value)} rows={4} maxLength={2000} autoFocus
              placeholder="e.g. The Musaned robot stops at the contract page…"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent p-2" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => pick(e.target.files?.[0])} />
              <button type="button" className="rounded-lg border border-gray-300 dark:border-gray-700 px-2.5 py-1 text-xs" onClick={() => fileRef.current?.click()}>📎 Add a picture</button>
              {!phone && navigator.mediaDevices?.getDisplayMedia && (
                <button type="button" className="rounded-lg border border-gray-300 dark:border-gray-700 px-2.5 py-1 text-xs"
                  onClick={async () => { try { setImage(await captureScreen()) } catch {} }}>🖥 Picture of the screen</button>
              )}
              {image && <span className="flex items-center gap-1 text-xs"><img src={image} alt="" className="h-8 rounded border" /> <button type="button" className="text-red-600" onClick={() => setImage(null)}>remove</button></span>}
            </div>
            {msg && <p className={`mt-2 text-xs ${msg.bad ? 'text-red-600' : 'text-green-700 dark:text-green-400'}`}>{msg.text}</p>}
            <button type="button" disabled={busy || !text.trim()} onClick={send}
              className="mt-3 w-full rounded-lg bg-indigo-600 py-2 font-semibold text-white disabled:opacity-50">{busy ? 'Sending…' : 'Send to Adal'}</button>
            {tickets.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xs font-semibold text-gray-500 mb-1">Your questions</h3>
                {tickets.map(t => (
                  <div key={t.id} className="border-t border-gray-200 dark:border-gray-800 py-2">
                    <div className="flex justify-between gap-2 text-xs"><span className="text-gray-500">{new Date(t.at).toLocaleString()}{t.who ? ` · ${t.who}` : ''}</span>
                      <span className={t.status === 'answered' ? 'text-green-700 dark:text-green-400 font-semibold' : 'text-gray-500'}>{STATUS[t.status] || t.status}</span></div>
                    <p className="whitespace-pre-wrap">{t.text}</p>
                    {(t.replies || []).map(r => <p key={r.id} className="mt-1 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 p-2 whitespace-pre-wrap"><b>Adal support:</b> {r.text}</p>)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
