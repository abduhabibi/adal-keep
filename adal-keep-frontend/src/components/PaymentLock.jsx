import { useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'
import { Link } from 'react-router-dom'

export default function PaymentLock() {
  const { subscription, unlock } = useAuth()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [showInput, setShowInput] = useState(false)

  // Only show something when we are truly in read-only / expired mode
  if (!subscription || ['active', 'trial', 'fresh'].includes(subscription.mode)) {
    return null
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!code.trim()) return
    setBusy(true)
    try {
      await unlock(code)
      toast.success('Access granted — timer restarted!')
      setTimeout(() => window.location.reload(), 800)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Invalid code')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] bg-amber-500 text-black shadow-lg">
      <div className="max-w-5xl mx-auto px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>⏳</span>
          <span>
            Subscription expired — system is <b>read-only</b>. 
            You can view everything, but writes, AI and file uploads are blocked.
          </span>
        </div>

        <div className="flex items-center gap-2">
          {!showInput ? (
            <>
              <button
                onClick={() => setShowInput(true)}
                className="px-3 py-1.5 bg-black/20 hover:bg-black/30 rounded-lg text-sm font-semibold transition"
              >
                Enter Access Code
              </button>
              <Link
                to="/settings"
                className="px-3 py-1.5 bg-black/10 hover:bg-black/20 rounded-lg text-sm font-medium transition"
              >
                Go to Settings →
              </Link>
            </>
          ) : (
            <form onSubmit={submit} className="flex items-center gap-2">
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Paste access code…"
                className="px-3 py-1.5 rounded-lg border border-black/20 bg-white text-sm font-mono w-64"
              />
              <button
                type="submit"
                disabled={busy || !code.trim()}
                className="px-3 py-1.5 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white rounded-lg text-sm font-semibold"
              >
                {busy ? '…' : 'Activate'}
              </button>
              <button
                type="button"
                onClick={() => setShowInput(false)}
                className="text-sm opacity-70 hover:opacity-100"
              >
                Cancel
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
