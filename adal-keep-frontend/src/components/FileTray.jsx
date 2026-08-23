import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { useFileCapture } from '../context/FileCaptureContext'

export default function FileTray() {
  const { capturedFiles, addFiles, removeFile, clearAll } = useFileCapture()
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
        const count = addFiles(files)
        if (count) toast.success(`${count} file(s) captured to tray`)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
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
      if (files.length > 0) {
        const count = addFiles(files)
        if (count) toast.success(`${count} file(s) captured to tray`)
      }
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
  }
  const handleTrayDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer?.getData('application/x-tray-file-id')) return
    const files = extractFiles(e)
    if (files.length > 0) {
      const count = addFiles(files)
      if (count) toast.success(`${count} file(s) captured to tray`)
    }
  }

  // Dragging OUT of tray into a FieldCard
  const handleDragStart = (e, file, index) => {
    e.dataTransfer.setData('application/x-tray-file-id', file.id)
    e.dataTransfer.setData('application/x-tray-file-index', String(index))
    e.dataTransfer.setData('text/plain', file.name)
    e.dataTransfer.effectAllowed = 'copyMove'
    window.__DRAGGED_TRAY_FILE__ = file
  }
  const handleDragEnd = () => { delete window.__DRAGGED_TRAY_FILE__ }

  // Outside click & Escape
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        buttonRef.current && !buttonRef.current.contains(e.target)
      ) setIsOpen(false)
    }
    const handleEscape = (e) => { if (e.key === 'Escape') setIsOpen(false) }
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
        <div className="fixed inset-0 z-[99998] bg-teal-500/10 backdrop-blur-sm border-4 border-dashed border-teal-500 flex items-center justify-center pointer-events-none animate-fade-in">
          <div className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl px-8 py-6 rounded-2xl shadow-2xl border border-teal-200 dark:border-teal-800 text-center">
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
        onDrop={handleTrayDrop}
        className="relative p-2.5 rounded-full transition-all duration-200 group hover:bg-slate-100/60 dark:hover:bg-white/5"
        aria-label="File Tray"
        title="Captured Files (Drag files anywhere or press Ctrl+V)"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-slate-600 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-white transition-colors">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" />
        </svg>
        {capturedFiles.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-teal-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center ring-2 ring-white dark:ring-slate-900 animate-pulse">
            {capturedFiles.length}
          </span>
        )}
      </button>

      {/* Tray dropdown */}
      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          onDragOver={handleTrayDragOver}
          onDrop={handleTrayDrop}
          className="fixed w-80 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200/60 dark:border-slate-800/60 rounded-2xl shadow-2xl overflow-hidden"
          style={{ top: dropdownPos.top, right: dropdownPos.right, zIndex: 99999 }}
        >
          <div className="p-4 border-b border-slate-200/60 dark:border-slate-800/60 flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-sm text-slate-800 dark:text-white">Quick Upload Tray</h3>
              <p className="text-[10px] text-slate-400 dark:text-slate-500">Drag files anywhere or press Ctrl+V</p>
            </div>
            {capturedFiles.length > 0 && (
              <button onClick={() => { clearAll(); toast.success('Tray cleared') }} className="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors font-medium">Clear all</button>
            )}
          </div>
          <div className="max-h-72 overflow-y-auto custom-scrollbar p-2">
            {capturedFiles.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-1 font-medium">Tray is empty</p>
                <p className="text-xs text-slate-400 dark:text-slate-500">Drop files anywhere or copy + Ctrl+V</p>
              </div>
            ) : (
              capturedFiles.map((file, index) => (
                <div
                  key={file.id || `${file.name}-${index}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, file, index)}
                  onDragEnd={handleDragEnd}
                  className="p-2.5 rounded-lg hover:bg-slate-100/80 dark:hover:bg-white/10 cursor-grab active:cursor-grabbing flex items-center gap-3 transition-all group"
                >
                  <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-400 group-hover:bg-teal-100/50 dark:group-hover:bg-teal-500/20 group-hover:text-teal-600 dark:group-hover:text-teal-400 transition-colors shrink-0 overflow-hidden">
                    {file.preview ? <img src={file.preview} alt="" className="w-full h-full object-cover" /> : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{file.name}</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500">{file.size ? `${(file.size / 1024).toFixed(1)} KB` : 'File'} • Drag to field</p>
                  </div>
                  <button onClick={() => { removeFile(index); toast.success('File removed') }} className="p-1.5 text-slate-400 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all hover:bg-red-50/50 dark:hover:bg-red-500/10 rounded-md" aria-label="Remove">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
