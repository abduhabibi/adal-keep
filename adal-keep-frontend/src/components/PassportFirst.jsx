import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { useFileCapture } from '../context/FileCaptureContext'
import { CameraShot, ON_PHONE } from './shared/PickFile'
import { onPhone, onCompanionOnline } from '../lib/phoneMode'
import { readPassportHere, warmPassportReader } from '../lib/passportHere'

/**
 * Step 1 of a new profile: the passport. Drag it in (from the tray, the
 * desktop or another window), paste it, click a tray file or choose it from
 * the PC. It is read at once (in this window, else on the main PC, with
 * the slower readers as help) and onRead() gets what was read.
 */
const ACCEPT = /^(image\/(jpeg|png|webp|bmp)|application\/pdf)$/

// Read here, in this window, before anything is sent: a phone, and an Adal
// Companion on its online pages (the passport is not uploaded to the internet
// just to be read; 127.0.0.1:47801 has the reader in /tess like the phone app).
// Another PC on the office network (an Adal Companion working on the main PC's pages) reads it in its own
// window too: the main PC may be busy with robots (the reader files come from it, /tess, and are kept).
const onOtherPc = () => typeof location !== 'undefined' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
const readsHere = () => (onPhone() || onCompanionOnline() || onOtherPc()) && !import.meta.env.VITE_ADMIN


// ---- the scan's progress: a light line over the page (transform/opacity only) and the real step ----
const STEP_TEXT = { reading: 'Reading the passport…', checking: 'Checking the numbers…', 'asking the cloud readers': 'Not clear at first — reading the whole page…', waiting: 'Waiting for the passport before it…' }
const STEP_AT = { waiting: 0, reading: 0, checking: 1, 'asking the cloud readers': 1 }
const STYLE = `
@keyframes adalScanLine { 0% { transform: translateY(0); opacity: 0 } 12% { opacity: 1 } 88% { opacity: 1 } 100% { transform: translateY(var(--h, 150px)); opacity: 0 } }
@keyframes adalScanPulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
.adal-scan-line { animation: adalScanLine 1.6s ease-in-out infinite; will-change: transform, opacity }
.adal-scan-dot { animation: adalScanPulse 1.2s ease-in-out infinite }
.adal-scan-stop .adal-scan-line, .adal-scan-stop .adal-scan-dot { animation-play-state: paused }
@media (prefers-reduced-motion: reduce) { .adal-scan-line, .adal-scan-dot { animation: none !important } .adal-scan-line { opacity: 0 } }
`
/** True while the window is shown: the animation is paused when it is hidden. */
function useVisible() {
  const [v, setV] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const f = () => setV(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', f)
    return () => document.removeEventListener('visibilitychange', f)
  }, [])
  return v
}

function ScanView({ busy, step, secs, moving, onPhone }) {
  const at = STEP_AT[step] ?? 0
  return (
    <div className={`flex w-full flex-col items-center gap-3 ${moving ? '' : 'adal-scan-stop'}`} role="status" aria-live="polite">
      <style>{STYLE}</style>
      <div className="relative overflow-hidden rounded-lg shadow" style={{ '--h': '150px' }}>
        {busy.preview
          ? <img src={busy.preview} alt="" className="block max-h-40 opacity-80" />
          : <div className="flex h-40 w-56 items-center justify-center text-5xl">📄</div>}
        <div className="adal-scan-line pointer-events-none absolute left-0 top-0 h-[3px] w-full bg-sky-400 shadow-[0_0_10px_2px_rgba(56,189,248,.8)]" />
      </div>
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
        <span className="adal-scan-dot h-2.5 w-2.5 rounded-full bg-sky-500" />
        {STEP_TEXT[step] || STEP_TEXT.reading} {secs}s
      </div>
      <div className="flex w-56 gap-1" aria-hidden="true">
        {['reading', 'checking', 'done'].map((k, i) => (
          <div key={k} className={`h-1 flex-1 rounded-full transition-colors ${i <= at ? 'bg-sky-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
        ))}
      </div>
      {secs >= 6 && <p className="text-xs text-slate-500">This page is harder to read — the form fills as soon as the numbers are sure.</p>}
    </div>
  )
}

export default function PassportFirst({ onRead, onSkip, onLater }) {
  const { capturedFiles } = useFileCapture()
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(null)        // { name, preview, t0 }
  const [problem, setProblem] = useState(null)  // { text, result }
  const [, tick] = useState(0)
  const [step, setStep] = useState('reading')   // the scan's real step: reading | checking | asking the cloud readers
  const seen = useVisible()
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
  useEffect(() => { if (readsHere()) warmPassportReader() }, [])
  // The PC's reader starts now too (it is ~0.5 s quicker on the first passport).
  useEffect(() => { if (!window.__ADAL_CLOUD && !readsHere()) api.post('/new-profile/warm').catch(() => {}) }, [])
  // The place of birth, region and date of issue follow the bottom lines (the form is filled at once).
  const placeBehind = (data) => {
    if (!data?.place_pending || !data.upload || !onLater) return
    api.get(`/new-profile/place/${encodeURIComponent(data.upload)}`, { adalNoCache: true, timeout: 15000 })
      .then(r => { const f = r.data?.fields; if (f && Object.values(f).some(Boolean)) onLater(f) }).catch(() => {})
  }
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
      let settled = false   // this window's own reading and the main PC's race: the first to answer is used
      const useHere = async (here) => {
        // The same passport already has a profile: said, not made twice.
        const pn = String(here.fields.passport_number || '').toUpperCase()
        const same = pn ? ((await api.get('/profiles', { params: { q: pn } }).catch(() => ({ data: [] }))).data || []).find(p => String(p.passport_number || '').toUpperCase() === pn) : null
        if (same) setProblem({ text: 'This passport already has a profile:', result: { ...here, existing: same } })
        else {
          onRead(here)   // the name, number, dates: at once
          // the place of birth and the date of issue, a moment later (the page keeps what a person typed)
          here.later?.then(f => { if (f && Object.values(f).some(Boolean)) onLater?.(f) }).catch(() => {})
        }
      }
      if (readsHere()) {
        // Read in this window; if it takes more than 5 s the main PC is asked too, and whichever answers first is used.
        const localP = readPassportHere(file).catch(() => null)
        const here = await Promise.race([localP, new Promise(r => setTimeout(() => r(null), 5000))])
        if (here) { settled = true; await useHere(here); return }
        localP.then(async r => {
          if (!r || settled) return
          settled = true
          await useHere(r)
          busyRef.current = false; setBusy(null)
        })
      }
      // The PC off: a passport the phone could not read is typed by hand; it goes with her profile.
      if (window.__ADAL_CLOUD && !import.meta.env.VITE_ADMIN) {
        const { pcOnline } = await import('../cloud/adapter.js')
        if (!(await pcOnline())) { onRead({ offline: true, hand: true, file, filename: file.name || 'passport.jpg', fields: {} }); return }
      }
      const fd = new FormData()
      fd.append('file', file, file.name || 'passport.jpg')
      let data
      setStep('reading')
      try {
        data = (await api.post('/new-profile/read', fd, { timeout: 60000, headers: { 'Content-Type': 'multipart/form-data' } })).data
        // The lines were not clear at once: the slower readers go on; ask how far it is, every second.
        for (let n = 0; data?.pending && !settled && n < 150; n++) {
          setStep(data.step || 'reading')
          await new Promise(r => setTimeout(r, 1000))
          data = (await api.get(`/new-profile/result/${encodeURIComponent(data.upload)}`, { adalNoCache: true, timeout: 15000 })).data
        }
        if (data?.pending) data = { error: 'it took too long — try a sharper picture, or fill the form by hand' }
      } catch (e) {
        // Adal Admin: the office PC did not answer — Admin reads it itself.
        if (!import.meta.env.VITE_ADMIN) throw e
        data = { queued: true }
      }
      if (import.meta.env.VITE_ADMIN && (data?.queued || !data?.doc_type)) {
        const r = await fetch('/admin/read-passport', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
        data = { ...(await r.json()), offline: true, file, filename: file.name }
      }
      if (settled) return   // this window's own reading answered first
      // Adal Admin / a phone with the office PC not answering: the reading is done there, not here.
      if (data.queued || (!data.doc_type && !data.error && !data.fields)) setProblem({ text: 'The office PC did not answer, and a passport is read there. Open Adal Keep on the office PC (or check its internet), then try again.', result: data })
      else if (data.error) setProblem({ text: `The passport could not be read (${data.error}). Try a sharper picture, or fill the form by hand.`, result: data })
      else if (data.doc_type !== 'Passport') setProblem({ text: `This looks like ${!data.doc_type || data.doc_type === 'other' ? 'something other than a passport' : `a ${data.doc_type}`}, not a passport data page.`, result: data })
      else if (data.existing) { setProblem({ text: 'This passport already has a profile:', result: data }); placeBehind(data) }
      else { onRead(data); placeBehind(data) }
    } catch (e) {
      if (settled) return
      setProblem({ text: `Reading failed: ${e.response?.data?.error || e.message}. Try again.` })
    } finally {
      busyRef.current = false
      setBusy(null)
      if (preview) URL.revokeObjectURL(preview)
    }
  }

  // A passport just scanned (the Scan button's "Add profile") is read at once.
  useEffect(() => { const f = window.__ADAL_SCAN_PASSPORT__; if (f) { window.__ADAL_SCAN_PASSPORT__ = null; read(f) } }, [])

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
            <ScanView busy={busy} step={step} secs={secs} moving={seen} onPhone={ON_PHONE} />
          </>
        ) : (
          <>
            <div className="text-5xl">🛂</div>
            <p className="text-lg font-bold text-slate-800 dark:text-slate-100">Start with the passport</p>
            {ON_PHONE ? <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">የፓስፖርቱን ፎቶ ያንሱ — ቀሪው ራሱ ይሞላል።</p> : <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
              {/* Amharic as written; English from lib/i18n.js (each piece reads right alone). */}
              የፓስፖርቱን ገጽ እዚህ ይጎትቱ — ከትሪው፣ ከዴስክቶፕ ወይም ከቴሌግራም — ወይም ይለጥፉ: <b>Ctrl+V</b>
              {' — ወይም '}<span className="font-semibold text-teal-700 dark:text-teal-300 underline">ከዚህ ኮምፒውተር ይምረጡ</span>.{' '}
              ስም፣ የፓስፖርት ቁጥር፣ የልደት ቀን፣ ጾታ እና የትውልድ ቦታ ራሳቸው ይሞላሉ።
            </p>}
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

