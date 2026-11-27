/**
 * Every notification closes (2026-11-27, the owner: "an X to close it, and away by itself after 3 seconds at
 * most"). One place for all of them: the Toaster draws each toast with an X and dismisses it at most
 * adal_toast_ms after it first showed, whatever duration its call asked for (Infinity, 2 minutes …).
 * What needs a person stays findable where it lives: the LMIS codes in the tray, a phone's call on Tasks.
 *
 * adal_toast_ms: localStorage (this window) or VITE_ADAL_TOAST_MS (the build); default 3000; 0 = off (each
 * toast's own duration, as before; the X stays).
 */
import { useEffect } from 'react'
import toast, { ToastBar } from 'react-hot-toast'

export function toastMs() {
  let v = null
  try { v = localStorage.getItem('adal_toast_ms') } catch {}
  if (v == null || v === '') v = import.meta.env.VITE_ADAL_TOAST_MS
  const n = Number(v)
  return v == null || v === '' || !Number.isFinite(n) || n < 0 ? 3000 : n
}

function Capped({ t, children }) {
  useEffect(() => {
    const cap = toastMs()
    if (!cap || !t.visible) return
    const left = Math.max(0, cap - (Date.now() - (t.createdAt || Date.now())))
    const id = setTimeout(() => toast.dismiss(t.id), left)
    return () => clearTimeout(id)
  }, [t.id, t.createdAt, t.visible])
  return children
}

/** The Toaster's children: each toast with its X, closed by itself in time. */
export const cappedToast = (t) => (
  <Capped t={t}>
    <ToastBar toast={t}>
      {({ icon, message }) => (
        <>
          {icon}
          {message}
          <button type="button" aria-label="Close" title="Close" onClick={() => toast.dismiss(t.id)}
              className="ml-1 -mr-1 shrink-0 rounded-md px-1.5 text-base leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700">×</button>
        </>
      )}
    </ToastBar>
  </Capped>
)
