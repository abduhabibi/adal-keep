import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useFileCapture } from '../context/FileCaptureContext'

/**
 * Scan: a person clicks, the PC that has the scanner scans one page (Windows' own WIA; a Companion
 * asks the main PC, whose scanner it is), the picture shows at once, is cropped right here, and goes
 * to Add profile, the tray, or a file (Save as). Backend: routes/scan.js. ADAL_SCAN=0 turns it off.
 */
const QUALITY = [[300, 'Passport / colour — 300 dpi'], [150, 'Quick — 150 dpi']]

export default function ScanButton({ className = '' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" data-tour="scan" onClick={() => setOpen(true)}
        className={`whitespace-nowrap rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-100 hover:border-teal-400 ${className}`}>
        🖨️ Scan
      </button>
      {open && <ScanDialog onClose={() => setOpen(false)} />}
    </>
  )
}

const fail = (e, fallback) => e?.response?.data?.message || e?.response?.data?.error || fallback

function ScanDialog({ onClose }) {
  const navigate = useNavigate()
  const { addFiles } = useFileCapture()
  const [info, setInfo] = useState(null)         // GET /scan/status
  const [dpi, setDpi] = useState(300)
  const [phase, setPhase] = useState('ready')    // ready | scanning | picture
  const [problem, setProblem] = useState('')
  const [secs, setSecs] = useState(0)
  const [file, setFile] = useState(null)         // the scan (File), cropped or whole
  const [url, setUrl] = useState('')
  const alive = useRef(true)
  const scanId = useRef(null)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { api.get('/scan/status', { adalNoCache: true, timeout: 30000 }).then(r => setInfo(r.data)).catch(e => setInfo({ code: 'no-scanner', message: fail(e, 'This PC could not be asked about its scanner.') })) }, [])
  useEffect(() => { if (phase !== 'scanning') return; const t = setInterval(() => setSecs(s => s + 1), 1000); return () => clearInterval(t) }, [phase])
  useEffect(() => { if (!file) { setUrl(''); return } const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u) }, [file])

  const start = async () => {
    setProblem(''); setSecs(0); setPhase('scanning')
    try {
      const { id } = (await api.post('/scan/start', { dpi: Number(dpi) }, { timeout: 30000 })).data
      scanId.current = id
      for (let n = 0; n < 130 && alive.current; n++) {
        await new Promise(r => setTimeout(r, 1000))
        const s = (await api.get(`/scan/${id}`, { adalNoCache: true, timeout: 15000 })).data
        if (s.state === 'error') { setProblem(s.error?.message || 'The scan failed.'); setPhase('ready'); return }
        if (s.state === 'done') {
          const blob = (await api.get(`/scan/${id}/image`, { responseType: 'blob', adalNoCache: true, timeout: 60000 })).data
          if (!alive.current) return
          setFile(new File([blob], `scan-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.jpg`, { type: 'image/jpeg' }))
          setPhase('picture'); return
        }
      }
      if (alive.current) { setProblem('The scan took too long. Check the scanner and try again.'); setPhase('ready') }
    } catch (e) {
      setProblem(fail(e, 'The scanner could not be reached. Try again.')); setPhase('ready')
    }
  }
  const cancel = async () => { try { await api.post('/scan/cancel') } catch {} }

  const toProfile = () => { window.__ADAL_SCAN_PASSPORT__ = file; onClose(); navigate('/profiles/new') }
  const toTray = () => { addFiles([file], { source: 'Scan' }); toast.success('In the tray'); onClose() }
  const saveAs = async () => {
    try {
      if (window.showSaveFilePicker) {
        const h = await window.showSaveFilePicker({ suggestedName: file.name, types: [{ description: 'JPEG picture', accept: { 'image/jpeg': ['.jpg'] } }] })
        const w = await h.createWritable(); await w.write(file); await w.close(); toast.success('Saved')
      } else {
        const a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); toast.success('Saved in Downloads')
      }
    } catch (e) { if (e?.name !== 'AbortError') toast.error('Could not save the file') }
  }

  const companion = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
  const can = info?.code === 'ready'
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-3" role="dialog" aria-label="Scan">
      <div className="max-h-[94vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">Scan</h2>
          <button type="button" onClick={() => { if (phase === 'scanning') cancel(); onClose() }} className="text-slate-500 hover:text-slate-800 text-xl leading-none" aria-label="Close">×</button>
        </div>

        {phase !== 'picture' && (
          <div className="space-y-3">
            <p className={`text-sm ${can ? 'text-slate-700 dark:text-slate-200' : 'text-amber-800 dark:text-amber-200'}`}>{info ? info.message : 'Looking for the scanner…'}</p>
            {companion && <p className="text-xs text-slate-500">This PC works on the main PC's pages, so the main PC's scanner is used. A printer on this PC that has no scan driver installed (for Epson: "Epson Scan 2") cannot scan from here.</p>}
            {problem && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{problem}</p>}
            {phase === 'scanning' ? (
              <div className="flex items-center gap-3">
                <span className="h-2.5 w-2.5 rounded-full bg-sky-500 animate-pulse" />
                <span className="text-sm font-semibold">Scanning… {secs}s <span className="font-normal text-slate-500">(put the page on the glass and keep the cover closed)</span></span>
                <button type="button" onClick={cancel} className="ml-auto rounded-lg border px-3 py-1.5 text-sm">Cancel</button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <select value={dpi} onChange={e => setDpi(e.target.value)} className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-2 text-sm">
                  {QUALITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <button type="button" disabled={!can} onClick={start} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">Scan</button>
              </div>
            )}
          </div>
        )}

        {phase === 'picture' && url && (
          <div className="space-y-3">
            <Crop url={url} file={file} onCrop={setFile} />
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={toProfile} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white">Add profile</button>
              <button type="button" onClick={toTray} className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm font-semibold">Tray</button>
              <button type="button" onClick={saveAs} className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm font-semibold">Save as…</button>
              <button type="button" onClick={() => { setFile(null); setPhase('ready') }} className="ml-auto rounded-lg px-3 py-2 text-sm text-slate-500 underline">Scan again</button>
            </div>
          </div>
        )}
      </div>
    </div>, document.body)
}

/** The scan with a frame to drag over the part to keep: "Crop" cuts the picture to it (the page's own pixels, no resizing). */
function Crop({ url, file, onCrop }) {
  const box = useRef(null)
  const [sel, setSel] = useState(null)      // { x0, y0, x1, y1 } as 0..1 of the picture
  const drag = useRef(null)
  const at = (e) => { const r = box.current.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) } }
  useEffect(() => setSel(null), [url])
  const down = (e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = at(e); setSel(null) }
  const move = (e) => { if (!drag.current) return; const p = at(e), s = drag.current; setSel({ x0: Math.min(s.x, p.x), y0: Math.min(s.y, p.y), x1: Math.max(s.x, p.x), y1: Math.max(s.y, p.y) }) }
  const up = () => { drag.current = null; setSel(s => (s && (s.x1 - s.x0 < 0.02 || s.y1 - s.y0 < 0.02) ? null : s)) }
  const cut = async () => {
    const img = box.current.querySelector('img')
    const w = img.naturalWidth, h = img.naturalHeight
    const sx = Math.round(sel.x0 * w), sy = Math.round(sel.y0 * h), sw = Math.round((sel.x1 - sel.x0) * w), sh = Math.round((sel.y1 - sel.y0) * h)
    const c = document.createElement('canvas'); c.width = sw; c.height = sh
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92))
    onCrop(new File([blob], file.name.replace(/\.jpg$/, '-crop.jpg'), { type: 'image/jpeg' }))
  }
  return (
    <div className="space-y-2">
      <div ref={box} className="relative mx-auto w-fit max-w-full touch-none select-none" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
        <img src={url} alt="The scan" className="block max-h-[62vh] max-w-full" draggable={false} />
        {sel && <div className="pointer-events-none absolute border-2 border-sky-500 bg-sky-400/10"
          style={{ left: `${sel.x0 * 100}%`, top: `${sel.y0 * 100}%`, width: `${(sel.x1 - sel.x0) * 100}%`, height: `${(sel.y1 - sel.y0) * 100}%`, boxShadow: '0 0 0 9999px rgba(0,0,0,.35)' }} />}
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-500">
        <span>Drag over the part to keep.</span>
        {sel && <button type="button" onClick={cut} className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white">Crop</button>}
      </div>
    </div>
  )
}
