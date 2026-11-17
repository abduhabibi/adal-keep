import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { useFileCapture } from '../context/FileCaptureContext'
import { CameraShot, ON_PHONE } from './shared/PickFile'
import { onPhone } from '../lib/phoneMode'
import { readPassportHere, warmPassportReader } from '../lib/passportHere'

/**
 * Step 1 of a new profile: the passport. Drag it in (from the tray, the
 * desktop or another window), paste it, click a tray file or choose it from
 * the PC. It is read at once (JEV, then this PC's reader and Gemini side by
 * side) and onRead() gets what was read.
 */
const ACCEPT = /^(image\/(jpeg|png|webp|bmp)|application\/pdf)$/

export default function PassportFirst({ onRead, onSkip }) {
  const { capturedFiles } = useFileCapture()
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(null)        // { name, preview, t0 }
  const [problem, setProblem] = useState(null)  // { text, result }
  const [, tick] = useState(0)
  const inputRef = useRef(null)
  const cameraRef = useRef(null)
  const galleryRef = useRef(null)
  const busyRef = useRef(false)
  const [camera, setCamera] = useState(false)
  // Camera: the live camera here when the browser allows it (phone app,
  // this PC's webcam), else the phone's own camera app.
  // On a phone the camera opens by itself (Gallery / Files are on it).
  useEffect(() => { if (ON_PHONE) { const t = setTimeout(() => openCamera(), 250); return () => clearTimeout(t) } }, [])
  // The phone's own passport reader starts while the camera is open: the read is then quick.
  useEffect(() => { if (onPhone() && !import.meta.env.VITE_ADMIN) warmPassportReader() }, [])
  const openCamera = () => {
    if (navigator.mediaDevices?.getUserMedia && window.isSecureContext) setCamera(true)
    else cameraRef.current?.click()
  }

  const read = async (file) => {
    if (!file || busyRef.current) return
    if (!ACCEPT.test(file.type || '') && !/\.(jpe?g|png|webp|bmp|pdf)$/i.test(file.name || '')) {
      setProblem({ text: `"${file.name}" is not a picture or PDF of a passport.` })
      return
    }
    busyRef.current = true
    setProblem(null)
    const preview = file.type?.startsWith('image/') ? URL.createObjectURL(file) : null
    setBusy({ name: file.name, preview, t0: Date.now() })
    try {
      // The phone with the office PC off: a passport is read on the PC, so her
      // details are typed here; the passport goes with her profile and the PC
      // reads it when it is on (asked on 2026-11-15: profiles made with the PC off).
      // A phone reads the passport itself first (lib/passportHere.js: its bottom
      // lines, check digits verified, and the place of birth by its position) —
      // no upload, no PC (asked on 2026-11-17).
      if (onPhone() && !import.meta.env.VITE_ADMIN) {
        const here = await readPassportHere(file).catch(() => null)
        if (here) {
          // The same passport already has a profile: said, not made twice.
          const pn = String(here.fields.passport_number || '').toUpperCase()
          const same = pn ? ((await api.get('/profiles', { params: { q: pn } }).catch(() => ({ data: [] }))).data || []).find(p => String(p.passport_number || '').toUpperCase() === pn) : null
          if (same) setProblem({ text: 'This passport already has a profile:', result: { ...here, existing: same } })
          else onRead(here)
          return
        }
      }
      // The PC off: a passport the phone could not read is typed by hand; it goes with her profile.
      if (window.__ADAL_CLOUD && !import.meta.env.VITE_ADMIN) {
        const { pcOnline } = await import('../cloud/adapter.js')
        if (!(await pcOnline())) { onRead({ offline: true, hand: true, file, filename: file.name || 'passport.jpg', fields: {} }); return }
      }
      const fd = new FormData()
      fd.append('file', file, file.name || 'passport.jpg')
      let data
      try {
        data = (await api.post('/new-profile/read', fd, { timeout: 120000, headers: { 'Content-Type': 'multipart/form-data' } })).data
      } catch (e) {
        // Adal Admin: the office PC did not answer — Admin reads it itself.
        if (!import.meta.env.VITE_ADMIN) throw e
        data = { queued: true }
      }
      if (import.meta.env.VITE_ADMIN && (data?.queued || !data?.doc_type)) {
        const r = await fetch('/admin/read-passport', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
        data = { ...(await r.json()), offline: true, file, filename: file.name }
      }
      // Adal Admin / a phone with the office PC not answering: the reading is done there, not here.
      if (data.queued || (!data.doc_type && !data.error && !data.fields)) setProblem({ text: 'The office PC did not answer, and a passport is read there. Open Adal Keep on the office PC (or check its internet), then try again.', result: data })
      else if (data.error) setProblem({ text: `The passport could not be read (${data.error}). Try a sharper picture, or fill the form by hand.`, result: data })
      else if (data.doc_type !== 'Passport') setProblem({ text: `This looks like ${!data.doc_type || data.doc_type === 'other' ? 'something other than a passport' : `a ${data.doc_type}`}, not a passport data page.`, result: data })
      else if (data.existing) setProblem({ text: 'This passport already has a profile:', result: data })
      else onRead(data)
    } catch (e) {
      setProblem({ text: `Reading failed: ${e.response?.data?.error || e.message}. Try again.` })
    } finally {
      busyRef.current = false
      setBusy(null)
      if (preview) URL.revokeObjectURL(preview)
    }
  }

  // Paste anywhere on the page (Ctrl+V): the passport, not the tray.
  useEffect(() => {
    const onPaste = (e) => {
      const files = Array.from(e.clipboardData?.files || [])
      if (!files.length) return
      e.preventDefault()
      e.stopPropagation() // the tray's own paste handler does not take it
      read(files[0])
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }, [])

  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => tick(n => n + 1), 500)
    return () => clearInterval(t)
  }, [busy])

  const onDrop = (e) => {
    e.preventDefault() // taken: the tray's page-wide drop handler skips it (and hides its overlay)
    setOver(false)
    let file = e.dataTransfer?.files?.[0]
    const trayId = e.dataTransfer?.getData('application/x-tray-file-id')
    if (!file && trayId) file = capturedFiles.find(f => f.id === trayId)
    if (!file && window.__DRAGGED_TRAY_FILE__) file = window.__DRAGGED_TRAY_FILE__
    if (file) read(file)
  }

  const secs = busy ? Math.floor((Date.now() - busy.t0) / 1000) : 0
  const trayPics = capturedFiles.filter(f => /^image\/|pdf/.test(f.type || '') || /\.(jpe?g|png|webp|pdf)$/i.test(f.name || ''))

  return (
    <div className="panel p-5 sm:p-6 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/60 rounded-xl shadow-sm space-y-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        className={`relative flex min-h-[260px] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${
          over ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/30' : 'border-slate-300 dark:border-slate-600 hover:border-teal-400 bg-slate-50/60 dark:bg-slate-900/40'
        }`}
      >
        {busy ? (
          <>
            {busy.preview
              ? <img src={busy.preview} alt="" className="max-h-40 rounded-lg shadow opacity-80" />
              : <div className="text-5xl">📄</div>}
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              <span className="h-2.5 w-2.5 rounded-full bg-sky-500 animate-pulse" />
              Reading the passport… {secs}s
            </div>
            <p className="text-xs text-slate-500">
              {secs < 4 ? 'Asking JEV…' : 'JEV, this PC and Gemini are reading it — the first sure answer fills the form.'}
            </p>
          </>
        ) : (
          <>
            <div className="text-5xl">🛂</div>
            <p className="text-lg font-bold text-slate-800 dark:text-slate-100">Start with the passport</p>
            <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
              {/* Amharic as written; English from lib/i18n.js (each piece reads right alone). */}
              የፓስፖርቱን ገጽ እዚህ ይጎትቱ — ከትሪው፣ ከዴስክቶፕ ወይም ከቴሌግራም — ወይም ይለጥፉ: <b>Ctrl+V</b>
              {' — ወይም '}<span className="font-semibold text-teal-700 dark:text-teal-300 underline">ከዚህ ኮምፒውተር ይምረጡ</span>.{' '}
              ስም፣ የፓስፖርት ቁጥር፣ የልደት ቀን፣ ጾታ እና የትውልድ ቦታ ራሳቸው ይሞላሉ።
            </p>
          </>
        )}
        <input ref={inputRef} type="file" accept="image/*,.pdf" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; read(f) }} />
      </div>

      {!busy && ON_PHONE && (
        <div className="grid grid-cols-3 gap-2">
          {[['📷', 'Camera', openCamera], ['🖼️', 'Gallery', () => galleryRef.current?.click()], ['📁', 'Files', () => inputRef.current?.click()]].map(([icon, label, fn]) => (
            <button key={label} type="button" onClick={fn}
              className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-3 text-sm font-semibold hover:border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 active:scale-[.98]">
              <span className="text-2xl">{icon}</span>{label}
            </button>
          ))}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; read(f) }} />
          <input ref={galleryRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; read(f) }} />
        </div>
      )}
      {camera && <CameraShot onShot={(f) => { setCamera(false); read(f) }} onClose={() => setCamera(false)}
        onGallery={() => { setCamera(false); galleryRef.current?.click() }} onFiles={() => { setCamera(false); inputRef.current?.click() }}
        onFail={() => { setCamera(false); cameraRef.current?.click() }} />}

      {!busy && trayPics.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">In your tray — click the passport:</p>
          <div className="flex flex-wrap gap-2">
            {trayPics.slice(0, 12).map(f => (
              <button key={f.id} type="button" onClick={() => read(f)} title={f.name}
                className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs hover:border-teal-400">
                {f.preview ? <img src={f.preview} alt="" className="h-8 w-8 rounded object-cover" /> : <span>📄</span>}
                <span className="max-w-[140px] truncate">{f.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {problem && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-900 dark:text-amber-100 space-y-2">
          <p>{problem.text}</p>
          {problem.result?.existing && (
            <p>
              <Link to={`/profiles/${problem.result.existing.id}`} className="font-semibold text-teal-700 dark:text-teal-300 underline">
                {problem.result.existing.full_name} — open it
              </Link>
            </p>
          )}
          {problem.result && !problem.result.error && problem.result.doc_type === 'Passport' && problem.result.existing && (
            <button type="button" className="text-xs underline" onClick={() => onRead(problem.result)}>Make a new profile anyway</button>
          )}
        </div>
      )}

      <div className="flex justify-between text-xs">
        <span className="text-slate-400">The passport is saved on the profile when you press Create.</span>
        <button type="button" onClick={onSkip} className="text-slate-500 hover:text-teal-700 underline">No passport yet — fill the form by hand</button>
      </div>
    </div>
  )
}

