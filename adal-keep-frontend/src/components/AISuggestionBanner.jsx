import { useState, useEffect, useCallback } from 'react'
import api from '../services/api'

export default function AISuggestionBanner() {
  const [suggestion, setSuggestion] = useState(null)
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(false)

  const requestSuggestion = useCallback(async (action, context = {}) => {
    if (loading) return
    setLoading(true)
    try {
      const res = await api.post('/messaging/ai/suggest', { action, context })
      if (res.data.suggestion) {
        setSuggestion(res.data.suggestion)
        setVisible(true)
        // Auto-hide after 15 seconds
        setTimeout(() => setVisible(false), 15000)
      }
    } catch {
      // Silent fail — don't interrupt workflow
    } finally {
      setLoading(false)
    }
  }, [loading])

  // Listen for custom events from other components
  useEffect(() => {
    const handler = (e) => {
      requestSuggestion(e.detail.action, e.detail.context)
    }
    window.addEventListener('adal-action', handler)
    return () => window.removeEventListener('adal-action', handler)
  }, [requestSuggestion])

  // Helper to dispatch actions from anywhere
  useEffect(() => {
    window.adalSuggest = (action, context) => {
      window.dispatchEvent(new CustomEvent('adal-action', { detail: { action, context } }))
    }
  }, [])

  if (!visible || !suggestion) return null

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9995] max-w-lg w-full animate-fade-in-up">
      <div className="glass-panel px-5 py-3 flex items-center gap-3 border-l-4 border-teal-500 shadow-xl">
        <span className="text-xl shrink-0">🤖</span>
        <p className="text-sm font-medium flex-1 leading-relaxed">{suggestion}</p>
        <button
          onClick={() => setVisible(false)}
          className="text-white/40 hover:text-white transition-colors p-1 rounded hover:bg-white/10 shrink-0"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
