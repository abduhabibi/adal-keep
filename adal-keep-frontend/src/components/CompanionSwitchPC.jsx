/**
 * "Log out of this main PC / Connect to another PC" — only in an Adal
 * Companion's window (never on the main PC): asks first, then
 * lib/companionOnline.js leaveMainPC() does the rest.
 */
import { useState } from 'react'
import { inCompanion, leaveMainPC } from '../lib/companionOnline'

const ASK = 'Are you sure?\n\nThis PC logs out of its main Adal Keep PC: its online account there is stopped and the saved connection is cleared. Then you can pick or type another main PC.\n\nNothing on the main PC itself is deleted.'

export default function CompanionSwitchPC({ compact = false, className = '' }) {
  const [busy, setBusy] = useState(false)
  if (!inCompanion()) return null
  const go = async () => {
    if (busy || !window.confirm(ASK)) return
    setBusy(true)
    try { await leaveMainPC() } catch { setBusy(false) }
  }
  const label = 'Log out of this main PC / Connect to another PC'
  return (
    <button type="button" onClick={go} disabled={busy} title={label} data-companion-switch=""
      className={className || `w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 disabled:opacity-60 ${compact ? 'justify-center px-0' : ''}`}>
      <svg className="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
      </svg>
      {!compact && <span className="text-left leading-tight">{busy ? 'Logging out…' : label}</span>}
    </button>
  )
}

/** The same in Settings, as its own box (also where a phone-width window has no side menu). */
export function CompanionSwitchCard() {
  if (!inCompanion()) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/60 bg-amber-50 px-4 py-3 dark:border-amber-500/30 dark:bg-amber-900/20">
      <div className="min-w-0 text-sm">
        <div className="font-semibold text-slate-900 dark:text-white">This PC is an Adal Companion</div>
        <div className="text-slate-600 dark:text-slate-300">To work with another main Adal Keep PC, log out of this one.</div>
      </div>
      <CompanionSwitchPC className="flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-60" />
    </div>
  )
}
