import { useState, useRef, useEffect } from 'react'
import api from '../services/api'

export default function AIChatWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'ሰላም! እኔ የAdal Keep AI ረዳት ነኝ። ፋይል ይለጥፉ ወይም መልእክት ይጻፉ።' }
  ])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)

  const STORAGE_KEY = 'adal_ai_chat_history'

  // Load persisted messages
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) setMessages(JSON.parse(saved))
    } catch {}
  }, [])

  // Save messages
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50))) } catch {}
  }, [messages])

  // Online/offline tracking
  useEffect(() => {
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // Auto-scroll & focus
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { if (isOpen && inputRef.current) inputRef.current.focus() }, [isOpen])

  const sendMessage = async (text) => {
    const msg = text || input.trim()
    if (!msg || isLoading) return
    if (!isOnline) {
      setMessages(p => [...p, { role: 'assistant', content: '⚠️ ኢንተርኔት የለም።' }])
      return
    }

    setInput('')
    setMessages(p => [...p, { role: 'user', content: msg }])
    setIsLoading(true)
    setPendingAction(null)

    try {
      const res = await api.post('/ai/process', { message: msg })
      const data = res.data

      setMessages(p => [...p, {
        role: 'assistant',
        content: data.suggestion || 'ምላሽ ማግኘት አልተቻለም።'
      }])

      if (data.pendingAction) {
        setPendingAction(data.pendingAction)
      }
    } catch {
      setMessages(p => [...p, { role: 'assistant', content: '❌ ከAI ጋር መገናኘት አልተቻለም።' }])
    } finally {
      setIsLoading(false)
    }
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file || isLoading) return

    setIsLoading(true)
    setMessages(p => [...p, { role: 'user', content: `📎 ${file.name} (${(file.size/1024).toFixed(0)}KB)` }])

    try {
      // Upload file first
      const formData = new FormData()
      formData.append('file', file)
      const uploadRes = await api.post('/files/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })

      const fileUrl = uploadRes.data.url || uploadRes.data.path

      // Analyze with vision AI
      const analyzeRes = await api.post('/ai/analyze-document', {
        image_url: fileUrl,
        filename: file.name
      })

      const data = analyzeRes.data

      if (data.success) {
        setMessages(p => [...p, { role: 'assistant', content: data.message }])
        if (data.pendingAction) {
          setPendingAction(data.pendingAction)
        }
      } else {
        setMessages(p => [...p, { role: 'assistant', content: `⚠️ ሰነዱን መተንተን አልተቻለም: ${data.error}` }])
      }
    } catch {
      setMessages(p => [...p, { role: 'assistant', content: '❌ ፋይል መስቀል ወይም መተንተን አልተቻለም።' }])
    } finally {
      setIsLoading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const confirmAction = async () => {
    if (!pendingAction || isLoading) return
    setIsLoading(true)

    try {
      const res = await api.post('/ai/confirm-action', {
        action: pendingAction,
        confirmed_by: 'current_user'
      })

      setMessages(p => [...p, {
        role: 'assistant',
        content: `✅ ${res.data.message || 'ተግባር ተፈጽሟል'}`
      }])
      setPendingAction(null)

      // Trigger suggestion banner
      if (window.adalSuggest) {
        window.adalSuggest('ai_action_completed', { type: pendingAction.type })
      }
    } catch {
      setMessages(p => [...p, { role: 'assistant', content: '❌ ተግባሩን መፈጸም አልተቻለም።' }])
    } finally {
      setIsLoading(false)
    }
  }

  const cancelAction = () => {
    setPendingAction(null)
    setMessages(p => [...p, { role: 'assistant', content: '❌ ተግባሩ ተሰርዟል።' }])
  }

  const formatActionPreview = (action) => {
    if (!action) return ''
    const labels = {
      create_profile: 'ፕሮፋይል ፍጠር',
      create_task: 'ተግባር ፍጠር',
      create_checklist: 'የክትትል ዝርዝር ፍጠር',
      assign_broker: 'አመቻች መድብ'
    }
    const label = labels[action.type] || action.type
    const details = Object.entries(action.data || {})
      .filter(([k,v]) => v && k !== 'source_file')
      .map(([k,v]) => `${k}: ${v}`)
      .join('\n')
    return `🔧 ${label}\n${details}${action.vision_confidence ? `\n📊 እርግጠኝነት: ${(action.vision_confidence*100).toFixed(0)}%` : ''}`
  }

  return (
    <>
      {/* Floating Button */}
      <button onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-gradient-to-br from-teal-500 to-teal-600 text-white shadow-lg hover:shadow-xl hover:scale-105 transition-all duration-300 z-[9990] flex items-center justify-center">
        {isOpen ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        )}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div className="fixed bottom-24 right-6 w-96 max-w-[calc(100vw-2rem)] h-[550px] max-h-[70vh] glass-panel flex flex-col z-[9990] animate-fade-in-up overflow-hidden">
          {/* Header */}
          <div className="p-4 border-b border-white/10 bg-gradient-to-r from-teal-500/10 to-purple-500/10">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-teal-400 to-teal-600 flex items-center justify-center text-white text-sm font-bold">AI</div>
              <div>
                <h3 className="font-semibold text-sm">Adal Keep AI</h3>
                <p className={`text-xs ${isOnline ? 'text-green-400' : 'text-red-400'}`}>
                  {isOnline ? '● ኦንላይን' : '○ ኦፍላይን'}
                </p>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-line ${
                  msg.role === 'user' ? 'bg-teal-500 text-white rounded-br-md' : 'bg-white/10 border border-white/10 rounded-bl-md'
                }`}>{msg.content}</div>
              </div>
            ))}

            {/* Pending Action Confirmation Card */}
            {pendingAction && (
              <div className="mx-2 p-4 rounded-xl border-2 border-teal-500/40 bg-teal-500/10 animate-fade-in-up">
                <pre className="text-xs whitespace-pre-wrap mb-3 font-mono leading-relaxed">{formatActionPreview(pendingAction)}</pre>
                <div className="flex gap-2">
                  <button onClick={confirmAction} disabled={isLoading}
                    className="flex-1 py-2 bg-teal-500 text-white rounded-lg text-xs font-bold hover:bg-teal-400 disabled:opacity-50 transition-all">
                    ✅ አረጋግጥ
                  </button>
                  <button onClick={cancelAction} disabled={isLoading}
                    className="flex-1 py-2 bg-white/10 text-white/70 rounded-lg text-xs font-bold hover:bg-white/20 disabled:opacity-50 transition-all">
                    ❌ ሰርዝ
                  </button>
                </div>
              </div>
            )}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white/10 border border-white/10 px-4 py-3 rounded-2xl rounded-bl-md">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-teal-400 rounded-full animate-bounce" style={{animationDelay:'0ms'}}/>
                    <span className="w-2 h-2 bg-teal-400 rounded-full animate-bounce" style={{animationDelay:'150ms'}}/>
                    <span className="w-2 h-2 bg-teal-400 rounded-full animate-bounce" style={{animationDelay:'300ms'}}/>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef}/>
          </div>

          {/* Input Area */}
          <div className="p-3 border-t border-white/10 space-y-2">
            {/* File Upload Button */}
            <div className="flex items-center gap-2">
              <button onClick={() => fileInputRef.current?.click()} disabled={isLoading}
                className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-white/60 hover:text-white hover:border-teal-500/30 transition-all disabled:opacity-50">
                📎 ሰነድ ለጥፍ
              </button>
              <span className="text-[10px] text-white/30">Passport, ID, PDF, Image</span>
              <input ref={fileInputRef} type="file" accept=".jpg,.jpeg,.png,.pdf,.bmp" onChange={handleFileUpload} className="hidden"/>
            </div>
            {/* Text Input */}
            <form onSubmit={(e) => { e.preventDefault(); sendMessage() }} className="flex gap-2">
              <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)}
                placeholder="መልእክት ይጻፉ ወይም ሰነድ ይለጥፉ..."
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-500/50 focus:ring-1 focus:ring-teal-500/30 transition-all placeholder:text-white/30"
                disabled={isLoading}/>
              <button type="submit" disabled={!input.trim() || isLoading}
                className="w-10 h-10 rounded-xl bg-teal-500 text-white flex items-center justify-center hover:bg-teal-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
