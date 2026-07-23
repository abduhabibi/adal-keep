import React from 'react'
import FileTray from '../FileTray'

export default function Navbar({ capturedFiles, setCapturedFiles }) {
  return (
    <nav className="h-16 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-6 sticky top-0 z-20 transition-colors duration-300">
      <div className="font-display text-lg font-bold text-slate-800 dark:text-white">
        Adal Nuzla
      </div>
      <div className="flex items-center gap-4">
        <FileTray capturedFiles={capturedFiles} setCapturedFiles={setCapturedFiles} />
      </div>
    </nav>
  )
}