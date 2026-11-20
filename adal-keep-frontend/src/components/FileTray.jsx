import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router-dom'
import { useFileCapture } from '../context/FileCaptureContext'
import { dragProfiles, isProfileDrag, profileCardsDropped } from '../lib/profileDrag'
import api from '../services/api'
import { useSmsCodes, SmsCodesRows } from './SmsCodesTray'
import Icon from './shared/Icon'
import TrayArrival, { FileThumb, whenAdded } from './TrayArrival'
import TrayPutOn from './TrayPutOn'
import { dragTrayFiles, endTrayDrag, isTrayDrag, trayFilesDropped, clipText, typingIn, tapMode } from '../lib/trayDrag'

// The tray's size (dragged at its corner) and whether it is the tall drawer: kept on this device.
const SIZE_KEY = 'adal-tray-size'
const readSize = () => { try { const s = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null'); if (s?.w && s?.h) return s } catch {} return { w: 640, h: 560, tall: false } }
const saveSize = (s) => { try { localStorage.setItem(SIZE_KEY, JSON.stringify(s)) } catch {} }

export default function FileTray({ phone = false }) {
  const { capturedFiles, addFiles, removeFilesById, clearAll, trayProfiles, addProfiles, removeProfile, clearProfiles } = useFileCapture()
  const [size, setSizeState] = useState(readSize)
  const setSize = (s) => { setSizeState(s); saveSize(s) }
  const [picked, setPicked] = useState(() => new Set())   // tray files ticked
  const lastPick = useRef(null)
  const [putOn, setPutOn] = useState(null)                // { files, profile? } "Put on…" open
  const [dragOut, setDragOut] = useState(false)           // a drag from the tray is going on
  const [vw, setVw] = useState(() => window.innerWidth)
  useEffect(() => { const r = () => setVw(window.innerWidth); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r) }, [])
  const tap = phone || tapMode()
  const navigate = useNavigate()
  const smsCodes = useSmsCodes()   // LMIS's SMS codes from the agency's phone
  const [hot, setHot] = useState(false) // a profile is dragged over the tray
  const [isOpen, setIsOpen] = useState(false)
  const [showGlobalOverlay, setShowGlobalOverlay] = useState(false)
  const buttonRef = useRef(null)
  const dropdownRef = useRef(null)
  const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 })
  const dragCounter = useRef(0)

  const extractFiles = (e) => {
    if (e.dataTransfer?.files?.length > 0) return Array.from(e.dataTransfer.files)
    if (e.clipboardData?.files?.length > 0) return Array.from(e.clipboardData.files)
    const items = e.dataTransfer?.items || e.clipboardData?.items
    if (!items) return []
    const files = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    return files
  }

  // TRUE only for real OS file drags (Finder/Desktop).
  // Internal drags (profiles, tray items) do NOT contain 'Files'.
  const isExternalFileDrag = (e) =>
    Array.from(e.dataTransfer?.types || []).includes('Files')

  // Global paste (Ctrl+V anywhere)
  useEffect(() => {
    const handlePaste = (e) => {
      const target = e.target
      if (
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) &&
        !e.clipboardData?.files?.length
      ) return
      const files = extractFiles(e)
      if (files.length > 0) {
        e.preventDefault()
        addFiles(files, { source: 'Pasted' })
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [addFiles])

  // "C" pressed twice quickly (not while typing): Windows' screen crop, as
  // Win+Shift+S; the cropped picture comes into the tray.
  useEffect(() => {
    if (import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_DEMO === '1') return
    let last = 0, busy = false
    // The PC's own watcher (adal-clip, lib/clipWatch.js) crops at once from any
    // program and sends the picture here: then it does it, not this page.
    const fromWatcher = (e) => {
      addFiles(e.detail || [], { source: 'Screen crop' })
    }
    window.addEventListener('adal-tray-files', fromWatcher)
    const onKey = async (e) => {
      if (window.__adalClipHook) return
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || String(e.key).toLowerCase() !== 'c') return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const now = Date.now()
      if (now - last > 450) { last = now; return }
      last = 0
      if (busy) return
      busy = true
      const wait = toast.loading('Crop what you need on the screen… (Esc: no crop)')
      try {
        const r = await api.post('/app/screen-clip', {}, { responseType: 'blob', timeout: 140000 })
        toast.dismiss(wait)
        if (r.status === 204 || !r.data?.size) { toast('Nothing was cropped'); return }
        const file = new File([r.data], `Screenshot ${new Date().toLocaleString().replace(/[/:]/g, '-')}.png`, { type: 'image/png' })
        addFiles([file], { source: 'Screen crop' })
      } catch (err) {
        toast.dismiss(wait)
        let msg = err.message
        try { msg = JSON.parse(await err.response?.data?.text?.())?.error || msg } catch {}
        toast.error(msg)
      } finally { busy = false }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('adal-tray-files', fromWatcher) }
  }, [addFiles])

  // Global drag & drop — ONLY intervenes for external OS file drags.
  // Internal profile/tray drags are left 100% alone (this was the bug).
  useEffect(() => {
    const handleDragEnter = (e) => {
      if (!isExternalFileDrag(e)) return
      e.preventDefault()
      dragCounter.current++
      setShowGlobalOverlay(true)
    }

    const handleDragLeave = (e) => {
      if (!isExternalFileDrag(e)) return
      dragCounter.current--
      if (dragCounter.current <= 0) {
        dragCounter.current = 0
        setShowGlobalOverlay(false)
      }
    }

    const handleDragOver = (e) => {
      if (!isExternalFileDrag(e)) return // DO NOT touch dropEffect for internal drags
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }

    const handleDrop = (e) => {
      if (!isExternalFileDrag(e)) return // let profile/tray drops work normally
      const alreadyHandled = e.defaultPrevented // a FieldCard already took this file
      e.preventDefault()
      dragCounter.current = 0
      setShowGlobalOverlay(false)
      if (alreadyHandled) return
      const files = extractFiles(e)
      if (files.length > 0) addFiles(files, { source: 'Dropped' })
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('drop', handleDrop)
    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('drop', handleDrop)
    }
  }, [addFiles])

  const openDropdown = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropdownPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right })
    }
    setIsOpen(true)
  }

  const toggleDropdown = () => (isOpen ? setIsOpen(false) : openDropdown())

  // Tray button/dropdown as drop target
  const handleTrayDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    if (isProfileDrag(e)) setHot(true)
  }
  const handleTrayDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setHot(false)
    if (e.dataTransfer?.getData('application/x-adal-from-tray')) return
    if (isProfileDrag(e)) {
      let cards = profileCardsDropped(e)
      // A drag that carried only ids: their names are looked up once.
      if (cards.some(c => !c.full_name)) {
        cards = await Promise.all(cards.map(c => c.full_name ? c : api.get(`/profiles/${c.id}`).then(r => ({ id: c.id, full_name: r.data?.full_name || '', phone_number: r.data?.phone_number || '' })).catch(() => c)))
      }
      const n = addProfiles(cards)
      toast.success(n ? `${cards.length === 1 ? cards[0].full_name || 'Profile' : cards.length + ' profiles'} kept in the tray` : 'Already in the tray')
      return
    }
    if (e.dataTransfer?.getData('application/x-tray-file-id')) return
    const files = extractFiles(e)
    if (files.length > 0) addFiles(files, { source: 'Dropped' })
  }

  // Dragging OUT of the tray (onto a FieldCard, a profile card, the passport
  // drop): the ticked files go together when the one dragged is ticked. The
  // tray fades and lets the mouse through while the drag goes on.
  const handleDragStart = (e, file) => {
    const list = picked.has(file.id) ? capturedFiles.filter(f => picked.has(f.id)) : [file]
    dragTrayFiles(e, list)
    setTimeout(() => setDragOut(true), 0)
  }
  const handleDragEnd = () => { endTrayDrag(); setDragOut(false) }

  const pickedFiles = capturedFiles.filter(f => picked.has(f.id))
  const togglePick = (file, e) => {
    setPicked(prev => {
      const next = new Set(prev)
      if (e?.shiftKey && lastPick.current) {
        const a = capturedFiles.findIndex(f => f.id === lastPick.current), b = capturedFiles.findIndex(f => f.id === file.id)
        if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(capturedFiles[i].id); return next }
      }
      next.has(file.id) ? next.delete(file.id) : next.add(file.id)
      return next
    })
    lastPick.current = file.id
  }
  // Files that left the tray are no longer ticked.
  useEffect(() => {
    setPicked(prev => { const ids = new Set(capturedFiles.map(f => f.id)); const next = new Set([...prev].filter(id => ids.has(id))); return next.size === prev.size ? prev : next })
  }, [capturedFiles])

  // The pop-up's "Tray" button opens it.
  useEffect(() => {
    const on = () => openDropdown()
    window.addEventListener('adal-open-tray', on)
    return () => window.removeEventListener('adal-open-tray', on)
  })

  // Ctrl+C with tray files ticked: they are copied, for Ctrl+V over a field (FieldCard).
  useEffect(() => {
    if (!isOpen || !picked.size) return
    const onCopy = (e) => {
      if (typingIn(document.activeElement) || String(window.getSelection?.() || '').trim()) return
      e.preventDefault()
      e.clipboardData.setData('text/plain', clipText(pickedFiles))
      window.__adalTrayClip = pickedFiles
      toast.success(`${pickedFiles.length === 1 ? pickedFiles[0].name : pickedFiles.length + ' files'} copied — point at a field and press Ctrl+V`)
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [isOpen, picked, capturedFiles])

  // Tray files dropped on a profile card (anything with data-profile-drop):
  // "Put on…" opens for her, to pick the field.
  useEffect(() => {
    const target = (e) => e.target?.closest?.('[data-profile-drop]')
    const over = (e) => { if (isTrayDrag(e) && target(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }
    const drop = (e) => {
      const el = target(e)
      if (!el || !isTrayDrag(e) || e.defaultPrevented) return
      e.preventDefault()
      const files = trayFilesDropped(e, capturedFiles)
      if (!files.length) return
      setPutOn({ files, profile: { id: Number(el.dataset.profileDrop), full_name: el.dataset.profileName || '' } })
    }
    document.addEventListener('dragover', over)
    document.addEventListener('drop', drop)
    return () => { document.removeEventListener('dragover', over); document.removeEventListener('drop', drop) }
  }, [capturedFiles])

  // The corner grip: drag it to make the tray bigger or smaller (kept).
  const startResize = (e) => {
    e.preventDefault()
    const x0 = e.clientX, y0 = e.clientY, w0 = size.w, h0 = size.h
    const move = (ev) => setSizeState(s => ({ ...s, w: Math.max(420, Math.min(window.innerWidth - 24, w0 + (x0 - ev.clientX))), h: Math.max(320, Math.min(window.innerHeight - 80, h0 + (ev.clientY - y0))) }))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setSizeState(s => { saveSize(s); return s }) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Outside click & Escape
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (e.target?.closest?.('[data-tray-keep]')) return
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        buttonRef.current && !buttonRef.current.contains(e.target)
      ) setIsOpen(false)
    }
    const handleEscape = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) setIsOpen(false) }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [])

  // Reposition on scroll/resize
  useEffect(() => {
    if (!isOpen) return
    const reposition = () => {
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect()
        setDropdownPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right })
      }
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [isOpen])

  return (
    <>
      {/* Global drop overlay (external files only) */}
      {showGlobalOverlay && createPortal(
        <div className="fixed inset-0 z-[99998] bg-teal-500/10 border-4 border-dashed border-teal-500 flex items-center justify-center pointer-events-none animate-fade-in">
          <div className="bg-white/95 dark:bg-slate-900/95 px-8 py-6 rounded-2xl shadow-2xl border border-teal-200 dark:border-teal-800 text-center">
            <svg className="w-12 h-12 text-teal-500 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
            <p className="text-lg font-bold text-teal-700 dark:text-teal-300">Drop files to add to tray</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Release to capture</p>
          </div>
        </div>,
        document.body
      )}

      {/* Tray button */}
      <button
        ref={buttonRef}
        onClick={toggleDropdown}
        onDragOver={handleTrayDragOver}
        onDragLeave={() => setHot(false)}
        onDrop={handleTrayDrop}
        className={`relative p-2.5 rounded-full transition-all duration-200 group hover:bg-slate-100/60 dark:hover:bg-white/5 ${hot ? 'ring-2 ring-teal-500 bg-teal-50 dark:bg-teal-900/30 scale-110' : ''}`}
        aria-label="Tray"
        title="Tray: files (drag them anywhere or Ctrl+V) and profiles (drag them here)"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-slate-600 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-white transition-colors">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" />
        </svg>
        {smsCodes.some(c => Date.now() - c.at < 5 * 60000) && (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-amber-500 px-1 text-[8px] font-bold text-white ring-2 ring-white dark:ring-slate-900" title="An LMIS code came: open the tray">SMS</span>
        )}
        {capturedFiles.length + trayProfiles.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-teal-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center ring-2 ring-white dark:ring-slate-900">
            {capturedFiles.length + trayProfiles.length}
          </span>
        )}
      </button>

      {/* The tray: a roomy panel of big pictures (a drawer when made tall; a sheet on a phone) */}
      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          onDragOver={handleTrayDragOver}
          onDrop={handleTrayDrop}
          role="dialog" aria-label="Tray"
          className={`solid-sheet fixed flex flex-col overflow-hidden border border-[var(--border-strong)] text-[var(--text)] shadow-[var(--shadow-xl)] transition-opacity ${tap ? 'rounded-t-[var(--radius-lg)]' : 'rounded-[var(--radius-lg)]'} ${dragOut ? 'pointer-events-none opacity-25' : ''}`}
          style={tap
            ? { left: 0, right: 0, bottom: 0, height: size.tall ? 'calc(var(--app-h,100vh) - 12px)' : 'min(85vh, calc(var(--app-h,100vh) - 48px))', zIndex: 99999 }
            : size.tall
              ? { top: dropdownPos.top, right: 12, bottom: 12, width: Math.min(Math.max(size.w, 640), vw - 24), zIndex: 99999 }
              : { top: dropdownPos.top, right: Math.max(12, dropdownPos.right), width: Math.min(size.w, vw - 24), height: `min(${size.h}px, calc(100vh - ${dropdownPos.top + 12}px))`, zIndex: 99999 }}
        >
          {/* Header */}
          <div className="relative flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-3">
            {tap && <span className="absolute left-1/2 top-1.5 h-1 w-10 -translate-x-1/2 rounded-full bg-[var(--border-strong)]" />}
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--primary-glow)] text-[var(--primary)]"><Icon name="inbox" size={18} /></span>
            <div className="min-w-0 flex-1">
              <h3 className="ak-card-title leading-tight">Tray <span className="text-sm font-medium ak-muted">· {capturedFiles.length} file{capturedFiles.length === 1 ? '' : 's'}</span></h3>
              <p className="truncate text-xs ak-muted">{tap ? 'Tap pictures to tick them, then Put on…' : 'Drag onto a field, a profile card or the passport drop · Ctrl+C, then Ctrl+V over a field'}</p>
            </div>
            <button type="button" onClick={() => setSize({ ...size, tall: !size.tall })} className="ak-icon-btn !h-9 !min-w-9 !p-0" title={size.tall ? 'Smaller' : 'Full height'} aria-label={size.tall ? 'Smaller' : 'Full height'}>
              <Icon name="chevronDown" size={18} className={size.tall ? 'rotate-180' : ''} />
            </button>
            <button type="button" onClick={() => setIsOpen(false)} className="ak-icon-btn !h-9 !min-w-9 !p-0" aria-label="Close"><Icon name="close" size={18} /></button>
          </div>

          {/* Ticked files: what to do with them */}
          {capturedFiles.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2 text-sm">
              <label className="flex cursor-pointer items-center gap-2 font-medium">
                <input type="checkbox" className="h-4 w-4" checked={picked.size > 0 && picked.size === capturedFiles.length}
                  ref={el => { if (el) el.indeterminate = picked.size > 0 && picked.size < capturedFiles.length }}
                  onChange={() => setPicked(picked.size === capturedFiles.length ? new Set() : new Set(capturedFiles.map(f => f.id)))} />
                {picked.size ? `${picked.size} ticked` : 'Tick all'}
              </label>
              <span className="flex-1" />
              {picked.size > 0 && (<>
                {!tap && <span draggable onDragStart={(e) => { dragTrayFiles(e, pickedFiles); setTimeout(() => setDragOut(true), 0) }} onDragEnd={handleDragEnd}
                  className="ak-icon-btn cursor-grab border border-[var(--border)] !h-8 !text-sm active:cursor-grabbing" title="Drag all ticked files onto a field">
                  <Icon name="transfer" size={15} /> Drag {picked.size}
                </span>}
                <button type="button" onClick={() => setPutOn({ files: pickedFiles })} className="ak-pill-btn !min-h-[32px] !px-3 !text-sm"><Icon name="user" size={15} /> Put on…</button>
                <button type="button" onClick={() => { removeFilesById([...picked]); toast.success('Taken out of the tray') }} className="ak-icon-btn !h-8 !text-sm !text-[var(--danger)]"><Icon name="trash" size={15} /> Remove</button>
              </>)}
              {!picked.size && <button type="button" onClick={() => { clearAll(); toast.success('Tray cleared') }} className="text-xs font-medium text-[var(--danger)]">Clear all</button>}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
            <SmsCodesRows codes={smsCodes} />
            {trayProfiles.length > 0 && (
              <div className="border-b border-[var(--border)] p-2">
                <div className="flex items-center justify-between px-1 pb-1">
                  <span className="ak-eyebrow">Profiles · {trayProfiles.length}</span>
                  <span className="flex gap-3 text-xs">
                    <button type="button" draggable onDragStart={(e) => { dragProfiles(e, trayProfiles); e.dataTransfer.setData('application/x-adal-from-tray', '1') }}
                      className="cursor-grab font-medium text-[var(--primary)]" title="Drag all onto a checklist">⠿ Drag all</button>
                    <button type="button" onClick={() => { clearProfiles(); toast.success('Profiles taken out of the tray') }} className="font-medium text-[var(--danger)]">Clear</button>
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {trayProfiles.map(p => (
                    <div key={p.id} draggable onDragStart={(e) => { dragProfiles(e, p); e.dataTransfer.setData('application/x-adal-from-tray', '1') }}
                      className="group flex max-w-[16rem] cursor-grab items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] py-1 pl-2.5 pr-1">
                      <button type="button" onClick={() => { setIsOpen(false); navigate(`/profiles/${p.id}`) }} className="min-w-0 truncate text-sm font-medium" title={p.phone_number || ''}>{p.full_name || `Profile #${p.id}`}</button>
                      <button type="button" onClick={() => removeProfile(p.id)} className="rounded-full p-0.5 ak-muted hover:text-[var(--danger)]" aria-label="Take out"><Icon name="close" size={13} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {capturedFiles.length === 0 ? (trayProfiles.length ? null : (
              <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--band)] text-[var(--primary)]"><Icon name="inbox" size={24} /></span>
                <p className="text-sm font-semibold">The tray is empty</p>
                <p className="max-w-xs text-xs ak-muted">{tap ? 'Pictures you share or scan come here.' : 'Paste (Ctrl+V), drop files on the window, or press C twice to crop the screen.'}</p>
              </div>
            )) : (
              <div className="grid content-start items-start gap-3 p-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tap ? 140 : 172}px, 1fr))` }}>
                {[...capturedFiles].reverse().map((file) => {
                  const on = picked.has(file.id)
                  return (
                    <div
                      key={file.id}
                      draggable={!tap}
                      onDragStart={(e) => handleDragStart(e, file)}
                      onDragEnd={handleDragEnd}
                      onClick={(e) => togglePick(file, e)}
                      title={file.name}
                      className={`group relative flex select-none flex-col overflow-hidden rounded-[var(--radius-md)] border bg-[var(--surface)] transition-shadow ${on ? 'border-[var(--primary)] ring-2 ring-[var(--primary-glow)]' : 'border-[var(--border)] hover:shadow-[var(--shadow-md)]'} ${tap ? '' : 'cursor-grab active:cursor-grabbing'}`}
                    >
                      <div className="relative aspect-[4/3] overflow-hidden bg-[var(--band)]">
                        <FileThumb file={file} className="absolute inset-0" />
                        <span className={`absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 shadow ${on ? 'border-[var(--primary)] bg-[var(--primary)] text-white dark:text-[#140e38]' : 'border-white/90 bg-black/25 text-transparent'}`}>
                          <Icon name="check" size={14} strokeWidth={2.6} />
                        </span>
                        <button type="button" onClick={(e) => { e.stopPropagation(); removeFilesById([file.id]) }}
                          className={`absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white transition-opacity ${tap ? '' : 'opacity-0 group-hover:opacity-100'}`} aria-label="Remove">
                          <Icon name="close" size={14} />
                        </button>
                        {tap && (
                          <button type="button" onClick={(e) => { e.stopPropagation(); setPutOn({ files: [file] }) }}
                            className="absolute bottom-1.5 right-1.5 rounded-full bg-[var(--primary)] px-2.5 py-1 text-xs font-semibold text-white dark:text-[#140e38]">Put on…</button>
                        )}
                      </div>
                      <div className="px-2.5 py-2">
                        <p className="truncate text-[13px] font-semibold">{file.name}</p>
                        <p className="truncate text-[11px] ak-muted">{file.device || 'This PC'} · {file.source || 'Added'} · {whenAdded(file.addedAt)}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* The corner grip (bottom left: the tray hangs from the top right) */}
          {!tap && !size.tall && (
            <div onPointerDown={startResize} title="Drag to make the tray bigger or smaller"
              className="absolute bottom-0 left-0 z-[5] h-5 w-5 cursor-nesw-resize" style={{ background: 'linear-gradient(225deg, transparent 50%, var(--border-strong) 50% 60%, transparent 60% 70%, var(--border-strong) 70% 80%, transparent 80%)' }} />
          )}

          {/* "Put on…" over the tray */}
          {putOn && (
            <div className="absolute inset-0 z-10 flex items-start justify-center bg-black/30 p-3">
              <div className="solid-sheet flex max-h-full w-full max-w-md flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border-strong)] p-3 shadow-[var(--shadow-xl)]">
                <div className="flex gap-1.5 overflow-x-auto">
                  {putOn.files.slice(0, 8).map(f => <div key={f.id} className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--band)]"><FileThumb file={f} /></div>)}
                </div>
                <TrayPutOn files={putOn.files} profile={putOn.profile || null} onCancel={() => setPutOn(null)} onDone={() => { setPutOn(null); setPicked(new Set()) }} />
              </div>
            </div>
          )}
        </div>,
        document.body
      )}

      {/* "Put on…" for files dropped on a profile card while the tray is shut */}
      {putOn && !isOpen && createPortal(
        <div data-tray-keep="" className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && setPutOn(null)}>
          <div className="solid-sheet flex max-h-[85vh] w-full max-w-md flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border-strong)] p-4 text-[var(--text)] shadow-[var(--shadow-xl)]">
            <div className="flex gap-1.5 overflow-x-auto">
              {putOn.files.slice(0, 8).map(f => <div key={f.id || f.name} className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--band)]"><FileThumb file={f} /></div>)}
            </div>
            <TrayPutOn files={putOn.files} profile={putOn.profile || null} onCancel={() => setPutOn(null)} onDone={() => setPutOn(null)} />
          </div>
        </div>,
        document.body
      )}

      <TrayArrival />
    </>
  )
}
