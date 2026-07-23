import { useState, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { useFileCapture } from '../context/FileCaptureContext'

export default function FileTray() {
  const { capturedFiles, setCapturedFiles } = useFileCapture()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef(null)

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleDragStart = (e, index) => {
    // Just pass the index, not the whole file object
    e.dataTransfer.setData('capturedFileIndex', index.toString())
    e.dataTransfer.effectAllowed = 'copy'
  }

  const clearAll = () => {
    // Clean up object URLs to prevent memory leaks
    capturedFiles.forEach(file => {
      if (file.preview) URL.revokeObjectURL(file.preview)
    })
    setCapturedFiles([])
    toast.success('Tray cleared')
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 text-slate-500 hover:text-teal-600 hover:bg-teal-50 rounded-full transition-colors relative"
        title="Captured Files (Drag from desktop or Ctrl+V)"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        {capturedFiles.length > 0 && (
          <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-teal-500 text-[10px] font-bold text-white ring-2 ring-white">
            {capturedFiles.length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden z-50 animate-fade-up">
          <div className="p-3 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-sm text-slate-700">Quick Upload Tray</h3>
              <p className="text-[10px] text-slate-400">Drag from desktop or Ctrl+V to add</p>
            </div>
            {capturedFiles.length > 0 && (
              <button onClick={clearAll} className="text-xs text-red-500 hover:text-red-700">Clear</button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto custom-scrollbar">
            {capturedFiles.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">
                <p className="mb-2">Tray is empty.</p>
                <p className="text-xs">Drag a file from your computer into this window, or copy an image and press Ctrl+V.</p>
              </div>
            ) : (
              capturedFiles.map((file, index) => (
                <div
                  key={`${file.name}-${index}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  className="p-3 border-b border-slate-50 hover:bg-teal-50 cursor-grab active:cursor-grabbing flex items-center gap-3 transition-colors group"
                >
                  <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 group-hover:bg-teal-100 group-hover:text-teal-600 transition-colors">
                    {file.type?.startsWith('image/') ? (
                      <img src={file.preview} alt="" className="w-full h-full object-cover rounded-lg" />
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">{file.name}</p>
                    <p className="text-xs text-slate-400">Drag to upload</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}