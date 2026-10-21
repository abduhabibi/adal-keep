import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { useFileCapture } from '../context/FileCaptureContext'

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
  const busyRef = useRef(false)

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
      const fd = new FormData()
      fd.append('file', file, file.name || 'passport.jpg')
      const { data } = await api.post('/new-profile/read', fd, { timeout: 120000, headers: { 'Content-Type': 'multipart/form-data' } })
      if (data.error) setProblem({ text: `The passport could not be read (${data.error}). Try a sharper picture, or fill the form by hand.`, result: data })
      else if (data.doc_type !== 'Passport') setProblem({ text: `This looks like ${data.doc_type === 'other' ? 'something other than a passport' : `a ${data.doc_type}`}, not a passport data page.`, result: data })
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
              Drag the passport page here — from the tray, the desktop or Telegram — paste it with <b>Ctrl+V</b>,
              or <span className="font-semibold text-teal-700 dark:text-teal-300 underline">choose it from this PC</span>.
              Name, passport number, birth date, sex and place of birth fill in by themselves.
            </p>
          </>
        )}
        <input ref={inputRef} type="file" accept="image/*,.pdf" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; read(f) }} />
      </div>

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
