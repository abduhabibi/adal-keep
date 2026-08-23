import { useState, useRef, useEffect } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'

export default function AIPage() {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'ሰላም! እኔ የAdal Keep AI ረዳት ነኝ። ጥያቄ ይጠይቁ ወይም ሰነድ ይለጥፉ።' }
  ])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const sendMessage = async (text) => {
    const msg = text || input.trim()
    if (!msg || isLoading) return

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
      const formData = new FormData()
      formData.append('file', file)
      const uploadRes = await api.post('/files/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      const fileUrl = uploadRes.data.url || uploadRes.data.path

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
      assign_broker: 'ደላላ መድብ'
    }
    const label = labels[action.type] || action.type
    const details = Object.entries(action.data || {})
      .filter(([k,v]) => v && k !== 'source_file')
      .map(([k,v]) => `${k}: ${v}`)
      .join('\n')
    return `🔧 ${label}\n${details}${action.vision_confidence ? `\n📊 እርግጠኝነት: ${(action.vision_confidence*100).toFixed(0)}%` : ''}`
  }

  return (
    <div className="animate-fade-up h-[calc(100vh-8rem)] flex flex-col">
      <PageHeader
        title="አርቴፊሻል ኢንተሊጀንስ"
        subtitle="ጥያቄ ይጠይቁ፣ ሰነድ ይለጥፉ፣ ወይም ተግባር ያዝዙ"
      />

      <div className="flex-1 flex flex-col bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[70%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-line ${
                msg.role === 'user' 
                  ? 'bg-teal-500 text-white rounded-br-md' 
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-bl-md'
              }`}>
                {msg.content}
              </div>
            </div>
          ))}

          {/* Pending Action Confirmation Card */}
          {pendingAction && (
            <div className="mx-auto max-w-md p-5 rounded-xl border-2 border-teal-500/40 bg-teal-50 dark:bg-teal-900/20">
              <pre className="text-xs whitespace-pre-wrap mb-4 font-mono leading-relaxed text-slate-700 dark:text-slate-300">
                {formatActionPreview(pendingAction)}
              </pre>
              <div className="flex gap-3">
                <button
                  onClick={confirmAction}
                  disabled={isLoading}
                  className="flex-1 py-2.5 bg-teal-500 text-white rounded-lg text-sm font-bold hover:bg-teal-600 disabled:opacity-50 transition-all"
                >
                  ✅ አረጋግጥ
                </button>
                <button
                  onClick={cancelAction}
                  disabled={isLoading}
                  className="flex-1 py-2.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg text-sm font-bold hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50 transition-all"
                >
                  ❌ ሰርዝ
                </button>
              </div>
            </div>
          )}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-slate-100 dark:bg-slate-800 px-4 py-3 rounded-2xl rounded-bl-md">
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
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 space-y-3">
          {/* File Upload Button */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              className="px-4 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:border-teal-500/50 transition-all disabled:opacity-50"
            >
              📎 ሰነድ ለጥፍ
            </button>
            <span className="text-xs text-slate-400">Passport, ID, PDF, Image</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.pdf,.bmp"
              onChange={handleFileUpload}
              className="hidden"
            />
          </div>

          {/* Text Input */}
          <form onSubmit={(e) => { e.preventDefault(); sendMessage() }} className="flex gap-3">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="መልእክት ይጻፉ..."
              className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="w-12 h-12 rounded-xl bg-teal-500 text-white flex items-center justify-center hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all shrink-0"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
