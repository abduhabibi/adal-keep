import { useState, useEffect, useRef } from 'react'
import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api'
const api = axios.create({ baseURL: API_BASE })

interface AIInstance {
  ai_id: string
  client_name: string
  username: string
  telegram_id: string | null
  is_online: boolean
  last_seen: string
  created_at: string
}

interface Message {
  id: number
  from: string
  message: string
  to_ai_id: string | null
  is_group: boolean
  group_name: string | null
  is_from_admin: boolean
  created_at: string
}

interface Lesson {
  id: number
  content: string
  category: string
  created_at: string
}

interface Workflow {
  workflow_name: string
  steps: string[]
  key_files: string[]
  estimated_time_minutes: number
  anomalies: string[]
  client_id: string
  analyzed_at: string
}

interface Group {
  id: number
  name: string
  ai_ids: string[]
  created_at: string
}

type Tab = 'chat' | 'groups' | 'lessons' | 'workflows' | 'clients'

export default function App() {
  const [tab, setTab] = useState<Tab>('chat')
  const [aiList, setAiList] = useState<AIInstance[]>([])
  const [selectedAI, setSelectedAI] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [newLesson, setNewLesson] = useState('')
  const [editingLesson, setEditingLesson] = useState<number | null>(null)
  const [editLessonContent, setEditLessonContent] = useState('')
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null)
  const [groupMessages, setGroupMessages] = useState<Message[]>([])
  const [groupInput, setGroupInput] = useState('')
  const [editingClient, setEditingClient] = useState<string | null>(null)
  const [editClientData, setEditClientData] = useState({ username: '', client_name: '', telegram_id: '' })
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const groupMsgEndRef = useRef<HTMLDivElement>(null)

  // Poll AI list
  useEffect(() => {
    const fetch = async () => {
      try { setAiList((await api.get('/messaging/ai/list')).data) } catch {}
    }
    fetch()
    const i = setInterval(fetch, 10000)
    return () => clearInterval(i)
  }, [])

  // Poll messages for selected AI
  useEffect(() => {
    if (!selectedAI || tab !== 'chat') return
    const fetch = async () => {
      try { setMessages((await api.get(`/messaging/messages?ai_id=${selectedAI}&limit=200`)).data) } catch {}
    }
    fetch()
    const i = setInterval(fetch, 3000)
    return () => clearInterval(i)
  }, [selectedAI, tab])

  // Fetch lessons
  useEffect(() => {
    if (tab !== 'lessons') return
    const fetch = async () => {
      try { setLessons((await api.get('/messaging/lessons')).data) } catch {}
    }
    fetch()
  }, [tab])

  // Fetch workflows
  useEffect(() => {
    if (tab !== 'workflows') return
    const fetch = async () => {
      try { setWorkflows((await api.get('/messaging/workflows')).data) } catch {}
    }
    fetch()
  }, [tab])

  // Fetch groups
  useEffect(() => {
    if (tab !== 'groups') return
    const fetch = async () => {
      try { setGroups((await api.get('/messaging/groups')).data) } catch {}
    }
    fetch()
  }, [tab])

  // Fetch group messages
  useEffect(() => {
    if (!selectedGroup) return
    const fetch = async () => {
      try { setGroupMessages((await api.get(`/messaging/groups/${selectedGroup}/messages`)).data) } catch {}
    }
    fetch()
    const i = setInterval(fetch, 3000)
    return () => clearInterval(i)
  }, [selectedGroup])

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { groupMsgEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [groupMessages])

  const sendMessage = async () => {
    if (!input.trim() || !selectedAI) return
    const msg = input.trim(); setInput('')
    try { await api.post('/messaging/send', { to_ai_id: selectedAI, from: 'admin', message: msg }) } catch {}
    setMessages(p => [...p, { id: Date.now(), from: 'admin', message: msg, to_ai_id: selectedAI, is_group: false, group_name: null, is_from_admin: true, created_at: new Date().toISOString() }])
  }

  const sendGroupMessage = async () => {
    if (!groupInput.trim() || !selectedGroup) return
    const msg = groupInput.trim(); setGroupInput('')
    try { await api.post(`/messaging/groups/${selectedGroup}/send`, { message: msg, from: 'admin' }) } catch {}
    setGroupMessages(p => [...p, { id: Date.now(), from: 'admin', message: msg, to_ai_id: null, is_group: true, group_name: groups.find(g => g.id === selectedGroup)?.name || '', is_from_admin: true, created_at: new Date().toISOString() }])
  }

  const addLesson = async () => {
    if (!newLesson.trim()) return
    try { await api.post('/messaging/lessons', { content: newLesson.trim(), category: 'manual', source_ai_id: 'admin' }); setNewLesson(''); setLessons((await api.get('/messaging/lessons')).data) } catch {}
  }

  const startEditLesson = (l: Lesson) => { setEditingLesson(l.id); setEditLessonContent(l.content) }

  const saveEditLesson = async () => {
    if (!editingLesson || !editLessonContent.trim()) return
    try { await api.put(`/messaging/lessons/${editingLesson}`, { content: editLessonContent.trim() }); setEditingLesson(null); setLessons((await api.get('/messaging/lessons')).data) } catch {}
  }

  const deleteLesson = async (id: number) => {
    if (!confirm('Delete this lesson?')) return
    try { await api.delete(`/messaging/lessons/${id}`); setLessons(p => p.filter(l => l.id !== id)) } catch {}
  }

  const createGroup = async () => {
    if (!newGroupName.trim()) return
    try { await api.post('/messaging/groups', { name: newGroupName.trim(), ai_ids: [] }); setNewGroupName(''); setGroups((await api.get('/messaging/groups')).data) } catch {}
  }

  const deleteGroup = async (id: number) => {
    if (!confirm('Delete this group?')) return
    try { await api.delete(`/messaging/groups/${id}`); setGroups(p => p.filter(g => g.id !== id)); if (selectedGroup === id) setSelectedGroup(null) } catch {}
  }

  const toggleGroupMember = async (groupId: number, aiId: string) => {
    const group = groups.find(g => g.id === groupId)
    if (!group) return
    const newIds = group.ai_ids.includes(aiId) ? group.ai_ids.filter(id => id !== aiId) : [...group.ai_ids, aiId]
    try { await api.put(`/messaging/groups/${groupId}/members`, { ai_ids: newIds }); setGroups((await api.get('/messaging/groups')).data) } catch {}
  }

  const startEditClient = (ai: AIInstance) => {
    setEditingClient(ai.ai_id)
    setEditClientData({ username: ai.username, client_name: ai.client_name, telegram_id: ai.telegram_id || '' })
  }

  const saveEditClient = async () => {
    if (!editingClient) return
    try { await api.put(`/messaging/ai/${editingClient}`, editClientData); setEditingClient(null); setAiList((await api.get('/messaging/ai/list')).data) } catch {}
  }

  const deleteClient = async (aiId: string) => {
    if (!confirm(`Delete AI client "${aiId}" and all its messages?`)) return
    try { await api.delete(`/messaging/ai/${aiId}`); setAiList(p => p.filter(a => a.ai_id !== aiId)); if (selectedAI === aiId) setSelectedAI(null) } catch {}
  }

  const analyzeWorkflows = async () => {
    try { const r = await api.post('/messaging/workflows/analyze', { hours: 24 }); alert(`Found ${r.data.workflows_found || 0} workflows`); setWorkflows((await api.get('/messaging/workflows')).data) } catch { alert('Analysis failed') }
  }

  const fmt = (d: string) => new Date(d).toLocaleTimeString('am-ET', { hour: '2-digit', minute: '2-digit' })
  const fmtDate = (d: string) => new Date(d).toLocaleDateString('am-ET', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'chat', label: 'Chat', icon: '💬' },
    { id: 'groups', label: 'Groups', icon: '👥' },
    { id: 'lessons', label: 'Lessons', icon: '📚' },
    { id: 'workflows', label: 'Workflows', icon: '🧠' },
    { id: 'clients', label: 'Clients', icon: '🖥️' },
  ]

  return (
    <div className="h-screen flex glass-panel-root     ">
      {/* Sidebar */}
      <div className="w-60 border-r border-white/10 flex flex-col shrink-0">
        <div className="p-4 border-b border-white/10">
          <h1 className="font-bold text-lg tracking-tight">🤖 Adal Portal</h1>
          <p className="text-[10px] /30 mt-1">AI Management Console</p>
        </div>
        <div className="flex flex-col p-2 gap-0.5">
          {tabs.map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setSelectedAI(null); setSelectedGroup(null) }}
              className={`text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center gap-2.5 ${tab === t.id ? 'bg-teal-500/15 text-teal-400 font-medium' : '/50 hover:/80 hover:bg-white/5'}`}>
              <span>{t.icon}</span> {t.label}
            </button>
          ))}
        </div>
        {/* AI List in Chat tab */}
        {tab === 'chat' && (
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5 border-t border-white/5 mt-2 pt-2">
            <p className="text-[10px] /30 px-3 mb-1 uppercase tracking-wider">AI Clients</p>
            {aiList.length === 0 && <p className="text-xs /20 text-center py-6">No clients registered</p>}
            {aiList.map(ai => (
              <button key={ai.ai_id} onClick={() => setSelectedAI(ai.ai_id)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-all flex items-center gap-2.5 ${selectedAI === ai.ai_id ? 'bg-teal-500/15 border border-teal-500/30' : 'hover:bg-white/5 border border-transparent'}`}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${ai.is_online ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' : 'bg-white/20'}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{ai.client_name}</p>
                  <p className="text-[10px] /30 truncate">@{ai.username} · {ai.telegram_id || 'no TG'}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* ===== CHAT TAB ===== */}
        {tab === 'chat' && (
          <>
            {!selectedAI ? (
              <div className="flex-1 flex items-center justify-center /20 text-sm">Select an AI client to chat</div>
            ) : (
              <>
                <div className="px-5 py-3 border-b border-white/10 flex items-center gap-3">
                  <span className={`w-2.5 h-2.5 rounded-full ${aiList.find(a => a.ai_id === selectedAI)?.is_online ? 'bg-green-400' : 'bg-white/20'}`} />
                  <div>
                    <p className="font-semibold text-sm">{aiList.find(a => a.ai_id === selectedAI)?.client_name}</p>
                    <p className="text-[10px] /40">@{aiList.find(a => a.ai_id === selectedAI)?.username} · {selectedAI}</p>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {messages.map(msg => (
                    <div key={msg.id} className={`flex ${msg.is_from_admin ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[70%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${msg.is_from_admin ? 'bg-teal-500  rounded-br-md' : 'bg-white/10 border border-white/10 rounded-bl-md'}`}>
                        <p>{msg.message}</p>
                        <p className={`text-[10px] mt-1 ${msg.is_from_admin ? '/60' : '/30'}`}>{fmt(msg.created_at)}</p>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
                <div className="p-3 border-t border-white/10">
                  <div className="flex gap-2">
                    <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()}
                      placeholder={`Message @${aiList.find(a => a.ai_id === selectedAI)?.username || '...'}...`}
                      className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-500/50" />
                    <button onClick={sendMessage} disabled={!input.trim()} className="px-5 py-2.5 bg-teal-500  rounded-xl text-sm font-medium hover:bg-teal-400 disabled:opacity-50 transition-all">Send</button>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* ===== GROUPS TAB ===== */}
        {tab === 'groups' && (
          <div className="flex-1 flex">
            {/* Group List */}
            <div className="w-64 border-r border-white/10 flex flex-col">
              <div className="p-3 border-b border-white/10">
                <div className="flex gap-2">
                  <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createGroup()}
                    placeholder="New group name..." className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-teal-500/50" />
                  <button onClick={createGroup} disabled={!newGroupName.trim()} className="px-3 py-1.5 bg-teal-500  rounded-lg text-xs font-medium hover:bg-teal-400 disabled:opacity-50">+</button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                {groups.map(g => (
                  <div key={g.id} className={`rounded-lg p-2.5 cursor-pointer transition-all flex items-center justify-between group ${selectedGroup === g.id ? 'bg-teal-500/15 border border-teal-500/30' : 'hover:bg-white/5 border border-transparent'}`}
                    onClick={() => setSelectedGroup(g.id)}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{g.name}</p>
                      <p className="text-[10px] /30">{g.ai_ids.length} members</p>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); deleteGroup(g.id) }} className="opacity-0 group-hover:opacity-100 /30 hover:text-red-400 text-xs transition-opacity">✕</button>
                  </div>
                ))}
                {groups.length === 0 && <p className="text-xs /20 text-center py-6">No groups yet</p>}
              </div>
            </div>
            {/* Group Chat / Member Management */}
            <div className="flex-1 flex flex-col">
              {!selectedGroup ? (
                <div className="flex-1 flex items-center justify-center /20 text-sm">Select a group</div>
              ) : (
                <>
                  <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{groups.find(g => g.id === selectedGroup)?.name}</p>
                      <p className="text-[10px] /40">{groups.find(g => g.id === selectedGroup)?.ai_ids.length} members</p>
                    </div>
                  </div>
                  {/* Member toggles */}
                  <div className="px-4 py-2 border-b border-white/5 flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                    {aiList.map(ai => {
                      const isMember = groups.find(g => g.id === selectedGroup)?.ai_ids.includes(ai.ai_id)
                      return (
                        <button key={ai.ai_id} onClick={() => toggleGroupMember(selectedGroup!, ai.ai_id)}
                          className={`text-[10px] px-2 py-1 rounded-full border transition-all ${isMember ? 'bg-teal-500/20 border-teal-500/40 text-teal-300' : 'border-white/10 /30 hover:border-white/20'}`}>
                          {isMember ? '✓ ' : '+ '}{ai.username}
                        </button>
                      )
                    })}
                  </div>
                  {/* Group Messages */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {groupMessages.map(msg => (
                      <div key={msg.id} className={`flex ${msg.is_from_admin ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[70%] px-4 py-2.5 rounded-2xl text-sm ${msg.is_from_admin ? 'bg-teal-500  rounded-br-md' : 'bg-white/10 border border-white/10 rounded-bl-md'}`}>
                          {!msg.is_from_admin && <p className="text-[10px] text-teal-400 mb-0.5 font-medium">{msg.from}</p>}
                          <p>{msg.message}</p>
                          <p className={`text-[10px] mt-1 ${msg.is_from_admin ? '/60' : '/30'}`}>{fmt(msg.created_at)}</p>
                        </div>
                      </div>
                    ))}
                    <div ref={groupMsgEndRef} />
                  </div>
                  <div className="p-3 border-t border-white/10">
                    <div className="flex gap-2">
                      <input value={groupInput} onChange={e => setGroupInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendGroupMessage()}
                        placeholder="Message group..." className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-500/50" />
                      <button onClick={sendGroupMessage} disabled={!groupInput.trim()} className="px-5 py-2.5 bg-teal-500  rounded-xl text-sm font-medium hover:bg-teal-400 disabled:opacity-50 transition-all">Send</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ===== LESSONS TAB ===== */}
        {tab === 'lessons' && (
          <div className="flex-1 flex flex-col">
            <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
              <div>
                <h2 className="font-semibold">Shared Lesson Storage</h2>
                <p className="text-xs /40 mt-0.5">All AIs learn from these lessons · {lessons.length} total</p>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {lessons.map(l => (
                <div key={l.id} className="bg-white/5 border border-white/10 rounded-xl p-4 group hover:border-teal-500/30 transition-all">
                  {editingLesson === l.id ? (
                    <div className="space-y-2">
                      <textarea value={editLessonContent} onChange={e => setEditLessonContent(e.target.value)}
                        className="w-full bg-white/5 border border-teal-500/30 rounded-lg px-3 py-2 text-sm focus:outline-none min-h-[60px]" autoFocus />
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setEditingLesson(null)} className="px-3 py-1 text-xs /50 hover:">Cancel</button>
                        <button onClick={saveEditLesson} className="px-3 py-1 text-xs bg-teal-500  rounded-lg hover:bg-teal-400">Save</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-between items-start gap-3">
                      <p className="text-sm leading-relaxed flex-1">{l.content}</p>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button onClick={() => startEditLesson(l)} className="/30 hover:text-teal-400 text-xs p-1 rounded hover:bg-white/5">✎</button>
                        <button onClick={() => deleteLesson(l.id)} className="/30 hover:text-red-400 text-xs p-1 rounded hover:bg-white/5">✕</button>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[10px] bg-white/10 px-2 py-0.5 rounded-full /40">{l.category}</span>
                    <span className="text-[10px] /30">{fmtDate(l.created_at)}</span>
                  </div>
                </div>
              ))}
              {lessons.length === 0 && <p className="text-center /20 py-12 text-sm">No lessons yet</p>}
            </div>
            <div className="p-3 border-t border-white/10">
              <div className="flex gap-2">
                <input value={newLesson} onChange={e => setNewLesson(e.target.value)} onKeyDown={e => e.key === 'Enter' && addLesson()}
                  placeholder="Add a new lesson for all AIs..." className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-500/50" />
                <button onClick={addLesson} disabled={!newLesson.trim()} className="px-5 py-2.5 bg-teal-500  rounded-xl text-sm font-medium hover:bg-teal-400 disabled:opacity-50 transition-all">Add</button>
              </div>
            </div>
          </div>
        )}

        {/* ===== WORKFLOWS TAB ===== */}
        {tab === 'workflows' && (
          <div className="flex-1 flex flex-col">
            <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
              <div>
                <h2 className="font-semibold">Learned Workflows</h2>
                <p className="text-xs /40 mt-0.5">AI-reverse-engineered from employee activity · {workflows.length} patterns</p>
              </div>
              <button onClick={analyzeWorkflows} className="px-4 py-1.5 bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-lg text-xs font-medium hover:bg-purple-500/30 transition-all">
                🧠 Analyze Now
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {workflows.map((w, i) => (
                <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-5 hover:border-purple-500/30 transition-all">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-sm text-purple-300">{w.workflow_name}</h3>
                    <span className="text-[10px] /30">{fmtDate(w.analyzed_at)}</span>
                  </div>
                  <div className="space-y-1.5 mb-3">
                    {w.steps.map((step, si) => (
                      <div key={si} className="flex items-start gap-2 text-sm">
                        <span className="text-purple-400/60 text-xs mt-0.5 shrink-0">{si + 1}.</span>
                        <span className="/70">{step}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {w.key_files?.map((f, fi) => (
                      <span key={fi} className="text-[10px] bg-blue-500/10 text-blue-300 px-2 py-0.5 rounded-full border border-blue-500/20">📄 {f}</span>
                    ))}
                    {w.estimated_time_minutes > 0 && (
                      <span className="text-[10px] bg-yellow-500/10 text-yellow-300 px-2 py-0.5 rounded-full border border-yellow-500/20">⏱ {w.estimated_time_minutes}min</span>
                    )}
                    {w.anomalies?.map((a, ai) => (
                      <span key={ai} className="text-[10px] bg-red-500/10 text-red-300 px-2 py-0.5 rounded-full border border-red-500/20">⚠ {a}</span>
                    ))}
                  </div>
                </div>
              ))}
              {workflows.length === 0 && <p className="text-center /20 py-12 text-sm">No workflows learned yet. Click "Analyze Now" after employees have been active.</p>}
            </div>
          </div>
        )}

        {/* ===== CLIENTS TAB ===== */}
        {tab === 'clients' && (
          <div className="flex-1 flex flex-col">
            <div className="px-5 py-3 border-b border-white/10">
              <h2 className="font-semibold">Registered AI Clients</h2>
              <p className="text-xs /40 mt-0.5">Manage connected client instances · {aiList.length} registered</p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {aiList.map(ai => (
                <div key={ai.ai_id} className="bg-white/5 border border-white/10 rounded-xl p-4 group hover:border-teal-500/30 transition-all">
                  {editingClient === ai.ai_id ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="text-[10px] /40 block mb-1">Username</label>
                          <input value={editClientData.username} onChange={e => setEditClientData({...editClientData, username: e.target.value})}
                            className="w-full bg-white/5 border border-teal-500/30 rounded-lg px-3 py-1.5 text-sm focus:outline-none" />
                        </div>
                        <div>
                          <label className="text-[10px] /40 block mb-1">Client Name</label>
                          <input value={editClientData.client_name} onChange={e => setEditClientData({...editClientData, client_name: e.target.value})}
                            className="w-full bg-white/5 border border-teal-500/30 rounded-lg px-3 py-1.5 text-sm focus:outline-none" />
                        </div>
                        <div>
                          <label className="text-[10px] /40 block mb-1">Telegram ID</label>
                          <input value={editClientData.telegram_id} onChange={e => setEditClientData({...editClientData, telegram_id: e.target.value})}
                            placeholder="@username or number" className="w-full bg-white/5 border border-teal-500/30 rounded-lg px-3 py-1.5 text-sm focus:outline-none" />
                        </div>
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setEditingClient(null)} className="px-3 py-1 text-xs /50 hover:">Cancel</button>
                        <button onClick={saveEditClient} className="px-3 py-1 text-xs bg-teal-500  rounded-lg hover:bg-teal-400">Save</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className={`w-3 h-3 rounded-full shrink-0 ${ai.is_online ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]' : 'bg-white/20'}`} />
                        <div>
                          <p className="font-semibold text-sm">{ai.client_name}</p>
                          <p className="text-xs /40">@{ai.username} · TG: {ai.telegram_id || '—'} · ID: {ai.ai_id}</p>
                          <p className="text-[10px] /25 mt-0.5">Last seen: {fmtDate(ai.last_seen)} · Created: {fmtDate(ai.created_at)}</p>
                        </div>
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => startEditClient(ai)} className="/30 hover:text-teal-400 p-1.5 rounded-lg hover:bg-white/5 text-sm" title="Edit">✎</button>
                        <button onClick={() => deleteClient(ai.ai_id)} className="/30 hover:text-red-400 p-1.5 rounded-lg hover:bg-white/5 text-sm" title="Delete">🗑</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {aiList.length === 0 && <p className="text-center /20 py-12 text-sm">No clients registered yet. Install Adal Keep on a client PC to register.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
