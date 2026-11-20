/**
 * The pop-up when files come into the tray (a crop, a paste, a drop, a
 * scan): a big picture to drag straight onto a field, a profile card or the
 * passport drop — or "Put on…" (a profile search and her fields). It stays
 * while the mouse is over it or a drag from it is going on; a phone taps.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFileCapture } from '../context/FileCaptureContext'
import { dragTrayFiles, endTrayDrag, tapMode } from '../lib/trayDrag'
import Icon from './shared/Icon'
import TrayPutOn from './TrayPutOn'

const SHOW_MS = 9000

export function FileThumb({ file, className = '' }) {
  const ext = (String(file?.name || '').split('.').pop() || 'file').slice(0, 4).toUpperCase()
  if (file?.preview) return <img src={file.preview} alt="" draggable={false} className={`block h-full w-full object-contain ${className}`} />
  return (
    <div className={`flex h-full w-full flex-col items-center justify-center gap-1 text-[var(--primary)] ${className}`}>
      <Icon name={/pdf/i.test(file?.type || ext) ? 'cv' : 'attach'} size={36} />
      <span className="text-xs font-bold tracking-wide">{ext}</span>
    </div>
  )
}

export const whenAdded = (t) => {
  if (!t) return ''
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function TrayArrival() {
  const { arrival, setArrival, capturedFiles } = useFileCapture()
  const [hover, setHover] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [putOn, setPutOn] = useState(false)
  const [pick, setPick] = useState(0)
  const timer = useRef(null)
  const tap = tapMode()

  // Only what is still in the tray.
  const files = (arrival?.files || []).filter(f => capturedFiles.some(c => c.id === f.id))
  const open = !!arrival && files.length > 0
  const close = () => { setArrival(null); setPutOn(false); setPick(0) }

  useEffect(() => { setPutOn(false); setPick(0) }, [arrival?.at])
  useEffect(() => {
    clearTimeout(timer.current)
    if (!open || hover || dragging || putOn) return
    timer.current = setTimeout(close, SHOW_MS)
    return () => clearTimeout(timer.current)
  }, [open, hover, dragging, putOn, arrival?.at])
  useEffect(() => {
    if (!open) return
    const k = (e) => { if (e.key === 'Escape' && !putOn) close() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [open, putOn])

  if (!open) return null
  const file = files[Math.min(pick, files.length - 1)]
  const many = files.length > 1

  return createPortal(
    <div
      role="dialog" aria-label="New in the tray"
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className={`solid-sheet fixed z-[99990] flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border-strong)] p-3 text-[var(--text)] shadow-[var(--shadow-xl)] animate-fade-in-up transition-opacity
        ${tap ? 'inset-x-3 bottom-[calc(66px+env(safe-area-inset-bottom))] max-h-[78vh]' : `bottom-5 right-5 ${putOn ? 'w-[400px]' : 'w-[360px]'} max-h-[calc(100vh-96px)]`}
        ${dragging ? 'pointer-events-none opacity-40' : ''}`}
    >
      <div className="flex items-center gap-2">
        {putOn
          ? <span className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--band)]"><FileThumb file={file} /></span>
          : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--primary-glow)] text-[var(--primary)]"><Icon name="inbox" size={16} /></span>}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{many ? `${files.length} files are in the tray` : 'New in the tray'}</p>
          <p className="truncate text-xs ak-muted">{file.source || 'Added'} · {file.device || 'This PC'} · {whenAdded(file.addedAt)}</p>
        </div>
        <button type="button" onClick={close} className="ak-icon-btn !h-8 !min-w-8 !p-0" aria-label="Close"><Icon name="close" size={16} /></button>
      </div>

      {!putOn && (
        <>
          <div
            draggable={!tap}
            onDragStart={(e) => { dragTrayFiles(e, many ? files : [file]); setTimeout(() => setDragging(true), 0) }}
            onDragEnd={() => { endTrayDrag(); setDragging(false); setHover(false) }}
            onClick={() => tap && setPutOn(true)}
            title={tap ? 'Tap: put it on a profile' : `Drag ${many ? 'them' : 'it'} onto a field, a profile card or the passport drop`}
            className={`relative h-56 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--band)] ${tap ? '' : 'cursor-grab active:cursor-grabbing'}`}
          >
            <FileThumb file={file} className="absolute inset-0" />
            {many && <span className="absolute right-2 top-2 rounded-full bg-[var(--primary)] px-2 py-0.5 text-xs font-bold text-white dark:text-[#140e38]">×{files.length}</span>}
            {!tap && <span className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-1.5 rounded-full bg-black/55 px-3 py-1 text-xs font-medium text-white">
              <Icon name="transfer" size={14} /> Drag {many ? 'all' : 'it'} onto a field or profile
            </span>}
          </div>
          {many && (
            <div className="flex gap-1.5 overflow-x-auto custom-scrollbar pb-1">
              {files.map((f, i) => (
                <button key={f.id} type="button" onClick={() => setPick(i)}
                  className={`h-12 w-12 shrink-0 overflow-hidden rounded-lg border-2 bg-[var(--band)] ${f === file ? 'border-[var(--primary)]' : 'border-transparent'}`}>
                  <FileThumb file={f} />
                </button>
              ))}
            </div>
          )}
          <p className="truncate text-xs font-medium" title={file.name}>{file.name}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPutOn(true)} className="ak-pill-btn !min-h-[38px] flex-1 justify-center !text-sm">
              <Icon name="user" size={16} /> Put on…
            </button>
            <button type="button" onClick={() => { window.dispatchEvent(new Event('adal-open-tray')); close() }}
              className="ak-icon-btn border border-[var(--border)] !text-sm">
              <Icon name="inbox" size={16} /> Tray
            </button>
          </div>
        </>
      )}
      {putOn && (
        <TrayPutOn files={files} compact onCancel={() => setPutOn(false)} onDone={close} />
      )}
    </div>,
    document.body
  )
}
