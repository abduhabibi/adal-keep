import { useState, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Button from '../components/shared/Button'
import Spinner from '../components/shared/Spinner'

const WELCOME = 'ሰላም! እኔ የAdal Keep AI ረዳት ነኝ። ጥያቄ ይጠይቁ።'

export default function AIPage() {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: WELCOME }
  ])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [agentStatus, setAgentStatus] = useState('idle')
  const [agentBusy, setAgentBusy] = useState(false)
  const [chats, setChats] = useState([])
  const [activeChatId, setActiveChatId] = useState(null)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    inputRef.current?.focus()
    loadChatList()
  }, [])

  const loadChatList = async () => {
    try {
      const res = await api.get('/ai/conversations')
      setChats(res.data || [])
    } catch {
      setChats([])
    }
  }

  /** Create a new conversation in DB and return its id */
  const createConversation = async (firstUserMessage) => {
    const title = firstUserMessage.slice(0, 40) || 'New Chat'
    const res = await api.post('/ai/conversations', { title })
    const conv = res.data
    setActiveChatId(conv.id)
    setChats(prev => [conv, ...prev])
    return conv.id
  }

  /** Save one message into the active conversation */
  const saveMessage = async (conversationId, role, content) => {
    if (!conversationId) return
    try {
      await api.post(`/ai/conversations/${conversationId}/messages`, { role, content })
    } catch {}
  }

  const startNewChat = () => {
    setMessages([{ role: 'assistant', content: WELCOME }])
    setPendingAction(null)
    setActiveChatId(null)
    setInput('')
  }

  const openChat = async (chatId) => {
    setIsLoading(true)
    setPendingAction(null)
    try {
      const res = await api.get(`/ai/conversations/${chatId}/messages`)
      const rows = res.data || []
      if (rows.length === 0) {
        setMessages([{ role: 'assistant', content: WELCOME }])
      } else {
        setMessages(rows.map(r => ({ role: r.role, content: r.content })))
      }
      setActiveChatId(chatId)
    } catch {
      toast.error('ቻት መጫን አልተቻለም')
    } finally {
      setIsLoading(false)
    }
  }

  const deleteChat = async (chatId, e) => {
    e.stopPropagation()
    if (!confirm('ይህ ቻት ይሰረዝ?')) return
    try {
      await api.delete(`/ai/conversations/${chatId}`)
      setChats(prev => prev.filter(c => c.id !== chatId))
      if (activeChatId === chatId) startNewChat()
      toast.success('ተሰርዟል')
    } catch {
      toast.error('መሰረዝ አልተቻለም')
    }
  }

  const sendMessage = async (text) => {
    const msg = (text || input).trim()
    if (!msg || isLoading) return

    setInput('')
    let convId = activeChatId

    // First message of a new chat → create conversation in DB
    if (!convId) {
      try {
        convId = await createConversation(msg)
      } catch {
        toast.error('ቻት መፍጠር አልተቻለም')
        return
      }
    }

    const nextMessages = [...messages, { role: 'user', content: msg }]
    setMessages(nextMessages)
    setIsLoading(true)
    setPendingAction(null)

    // Persist user message
    await saveMessage(convId, 'user', msg)

    try {
      // Only current chat history goes to the model
      const historyForApi = nextMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(0, -1)
        .map(m => ({ role: m.role, content: m.content }))

      const res = await api.post('/ai/process', {
        message: msg,
        history: historyForApi
      })

      const data = res.data
      const reply = data.suggestion || 'ምላሽ ማግኘት አልተቻለም።'

      setMessages(p => [...p, { role: 'assistant', content: reply }])
      await saveMessage(convId, 'assistant', reply)

      if (data.pendingAction) setPendingAction(data.pendingAction)

      // Refresh sidebar order
      loadChatList()
    } catch {
      const errMsg = '❌ ከAI ጋር መገናኘት አልተቻለም።'
      setMessages(p => [...p, { role: 'assistant', content: errMsg }])
      await saveMessage(convId, 'assistant', errMsg)
    } finally {
      setIsLoading(false)
    }
  }


  const refreshAgentStatus = async () => {
    try {
      const res = await api.get('/agent/status')
      setAgentStatus(res.data.status || 'idle')
    } catch {}
  }

  useEffect(() => {
    refreshAgentStatus()
    const id = setInterval(refreshAgentStatus, 3000)
    return () => clearInterval(id)
  }, [])

  const startAgent = async () => {
    setAgentBusy(true)
    try {
      const res = await api.post('/agent/start', { openPextran: true })
      if (res.data.ok) {
        toast.success(res.data.message || 'Brave started')
        setAgentStatus('running')
      } else {
        toast.error(res.data.error || 'Failed to start')
      }
    } catch (e) {
      toast.error(e.response?.data?.error || 'Agent start failed')
    } finally {
      setAgentBusy(false)
      refreshAgentStatus()
    }
  }

  const stopAgentBtn = async () => {
    setAgentBusy(true)
    try {
      await api.post('/agent/stop')
      toast.success('Agent stopped')
      setAgentStatus('stopped')
    } catch {
      toast.error('Stop failed')
    } finally {
      setAgentBusy(false)
      refreshAgentStatus()
    }
  }

  const confirmAction = async () => {
    if (!pendingAction) return
    setIsLoading(true)
    try {
      const res = await api.post('/ai/confirm-action', { action: pendingAction })
      const text = res.data.message || 'ተከናውኗል'
      toast.success(text)
      setMessages(p => [...p, { role: 'assistant', content: text }])
      if (activeChatId) await saveMessage(activeChatId, 'assistant', text)
      setPendingAction(null)
    } catch {
      toast.error('እርምጃው አልተሳካም')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4 animate-fade-up">
      {/* ===== MAIN CHAT ===== */}
      <div className="flex-1 flex flex-col min-w-0">
        <PageHeader
          title="አርቴፊሻል ኢንተሊጀንስ"
          subtitle="ስለ መረጃ ጥያቄዎች ይጠይቁ ወይም ስራ ያዝዙ"
          action={
            <div className="flex gap-2 flex-wrap">
              <Button variant="secondary" onClick={startNewChat}>+ አዲስ ቻት</Button>
              {(agentStatus === 'running' || agentStatus === 'starting') ? (
                <Button variant="danger" onClick={stopAgentBtn} isLoading={agentBusy}>
                  ⏹ Stop Agent
                </Button>
              ) : (
                <Button onClick={startAgent} isLoading={agentBusy}>
                  🌐 Open Brave + Pextran
                </Button>
              )}
            </div>
          }
        />

        <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-teal-600 text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-slate-100 dark:bg-slate-800 rounded-2xl px-4 py-3">
                <Spinner size="sm" />
              </div>
            </div>
          )}

          {pendingAction && (
            <div className="flex justify-start">
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-2xl p-4 max-w-[80%]">
                <p className="text-sm mb-3 font-medium">AI እርምጃ ሀሳብ አቅርቧል — ያጽድቁ?</p>
                <pre className="text-xs bg-white dark:bg-slate-900 p-2 rounded mb-3 overflow-x-auto">
                  {JSON.stringify(pendingAction, null, 2)}
                </pre>
                <div className="flex gap-2">
                  <Button size="sm" onClick={confirmAction} >
                    አጽድቅ
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setPendingAction(null)}>
                    ሰርዝ
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="mt-4 flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
            placeholder="መልእክትዎን ይጻፉ..."
            className="flex-1 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
           
          />
          <Button onClick={() => sendMessage()} disabled={isLoading || !input.trim()}>
            ላክ
          </Button>
        </div>
      </div>

      {/* ===== RIGHT HISTORY SIDEBAR (from DB) ===== */}
      <div className="w-64 shrink-0 border-l border-slate-200 dark:border-slate-700 pl-4 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-sm text-slate-700 dark:text-slate-300">የቻት ታሪክ</h3>
          <button onClick={startNewChat} className="text-xs text-teal-600 hover:underline">
            አዲስ
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-1 custom-scrollbar">
          {chats.length === 0 ? (
            <p className="text-xs text-slate-400 py-4 text-center">ታሪክ የለም</p>
          ) : (
            chats.map(c => (
              <div
                key={c.id}
                onClick={() => openChat(c.id)}
                className={`group flex items-center gap-1 w-full text-left px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${
                  activeChatId === c.id
                    ? 'bg-teal-50 dark:bg-teal-900/30 text-teal-700'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
                }`}
              >
                <span className="flex-1 truncate">{c.title || 'ቻት'}</span>
                <button
                  onClick={(e) => deleteChat(c.id, e)}
                  className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 p-0.5"
                  title="ሰርዝ"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <p className="text-[10px] text-slate-400 mt-3 leading-tight">
          ቻቶች በዳታቤዝ ይቀመጣሉ። አዲስ ቻት ሲጀምሩ ቀድሞው አይረሳም — ከጎን ይመልከቱ።
        </p>
      </div>
    </div>
  )
}
