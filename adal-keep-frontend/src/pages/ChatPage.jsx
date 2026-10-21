import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

/**
 * Chat between every agency that runs Adal Keep — like Telegram, without links.
 *   Everyone     one group with every agency
 *   Adal Keep    this agency's inbox with Adal (support, payments)
 *   <agency>     a private chat with that agency
 */
const LINK = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|[a-z0-9-]+\.(com|net|org|io|me|et|sa|ae|kw|qa|info|biz|co|app|link|xyz|ly|gl|site|online|shop)(\/|\s|$))/i

const timeOf = (t) => {
  const d = new Date(t), now = new Date()
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function Avatar({ name, kind }) {
  const bg = kind === 'group' ? 'bg-gradient-to-br from-teal-500 to-sky-500'
    : kind === 'admin' ? 'bg-gradient-to-br from-violet-500 to-pink-500' : 'bg-slate-400 dark:bg-slate-600'
  const letter = kind === 'group' ? '👥' : kind === 'admin' ? 'A' : (name || '?').trim()[0]?.toUpperCase()
  return <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${bg}`}>{letter}</span>
}

export default function ChatPage() {
  const [status, setStatus] = useState(null)     // { configured, me } | { error }
  const [agencies, setAgencies] = useState([])
  const [convs, setConvs] = useState([])
  const [open, setOpen] = useState(null)         // { id, kind, title }
  const [msgs, setMsgs] = useState([])
  const [text, setText] = useState('')
  const [pic, setPic] = useState(null)           // File waiting to be sent
  const picUrl = useMemo(() => (pic ? URL.createObjectURL(pic) : null), [pic])
  useEffect(() => () => { if (picUrl) URL.revokeObjectURL(picUrl) }, [picUrl])
  const [sending, setSending] = useState(false)
  const [q, setQ] = useState('')
  const [dragging, setDragging] = useState(false)
  const threadRef = useRef(null)
  const fileRef = useRef(null)
  const lastIdRef = useRef(0)

  // Who am I, the agencies, my chats — every few seconds.
  const loadSide = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api.get('/chat/conversations'), api.get('/chat/agencies')])
      setConvs(c.data || []); setAgencies(a.data || [])
    } catch (e) { setStatus(s => s?.configured ? s : { error: e.response?.data?.error || e.message }) }
  }, [])

  useEffect(() => {
    api.get('/chat/status').then(r => setStatus(r.data)).catch(e => setStatus({ error: e.response?.data?.error || e.message }))
  }, [])
  useEffect(() => {
    if (!status?.configured) return
    loadSide()
    const t = setInterval(loadSide, 4000)
    return () => clearInterval(t)
  }, [status?.configured, loadSide])

  // The open chat: new messages every 2 s.
  useEffect(() => {
    if (!open) return
    let alive = true
    lastIdRef.current = 0
    setMsgs([])
    const pull = async () => {
      try {
        const { data } = await api.get('/chat/messages', { params: { conversation: open.id, after: lastIdRef.current } })
        if (!alive || !data?.length) return
        lastIdRef.current = data[data.length - 1].id
        setMsgs(m => [...m, ...data.filter(x => !m.some(y => y.id === x.id))])
      } catch {}
    }
    pull()
    const t = setInterval(pull, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [open?.id])

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.length, open?.id])

  const me = status?.me
  const names = useMemo(() => Object.fromEntries(agencies.map(a => [a.id, a.is_admin ? 'Adal Keep' : a.name])), [agencies])
  const pinned = convs.filter(c => c.kind === 'group' || c.kind === 'admin').sort((a, b) => (a.kind === 'group' ? 0 : 1) - (b.kind === 'group' ? 0 : 1))
  const directs = Object.fromEntries(convs.filter(c => c.kind === 'direct').map(c => [c.other_id, c]))
  const others = agencies
    .filter(a => !a.is_admin && a.id !== me?.id && (!q.trim() || a.name.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => new Date(directs[b.id]?.last_message_at || 0) - new Date(directs[a.id]?.last_message_at || 0) || a.name.localeCompare(b.name))
  const unreadTotal = convs.reduce((n, c) => n + Number(c.unread || 0), 0)

  const openAgency = async (a) => {
    const existing = directs[a.id]
    if (existing) return setOpen({ id: existing.id, kind: 'direct', title: a.name })
    try {
      const { data } = await api.post(`/chat/direct/${a.id}`)
      setOpen({ id: data.id, kind: 'direct', title: a.name })
      loadSide()
    } catch (e) { toast.error(e.response?.data?.error || 'Could not open the chat') }
  }

  const hasLink = LINK.test(text)
  const send = async () => {
    if (!open || sending || hasLink || (!text.trim() && !pic)) return
    setSending(true)
    try {
      const fd = new FormData()
      fd.append('conversation', open.id)
      fd.append('body', text.trim())
      if (pic) fd.append('image', pic, pic.name || 'picture.jpg')
      const { data } = await api.post('/chat/send', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      if (data?.id) { setMsgs(m => (m.some(x => x.id === data.id) ? m : [...m, data])); lastIdRef.current = Math.max(lastIdRef.current, data.id) }
      setText(''); setPic(null)
      loadSide()
    } catch (e) { toast.error(e.response?.data?.error || 'Not sent') }
    finally { setSending(false) }
  }

  const takePicture = (file) => {
    if (!file) return
    if (!/^image\//.test(file.type)) return toast.error('Only pictures can be sent.')
    if (file.size > 8 * 1024 * 1024) return toast.error('The picture is larger than 8 MB.')
    setPic(file)
  }

  if (!status) return <div className="p-10 text-slate-500">Opening the chat…</div>
  if (!status.configured) {
    return (
      <div className="m-6 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-8 text-center">
        <div className="text-4xl">💬</div>
        <h2 className="mt-2 text-lg font-bold">The chat is not connected on this PC yet</h2>
        <p className="mt-1 text-sm text-slate-500">{status.error || 'Adal adds the chat server to Adal Keep — then every agency appears here.'}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 bg-white dark:bg-slate-900">
      {/* ---------------------------------------------------------- list */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200 dark:border-slate-700 min-h-0">
        <div className="border-b border-slate-200 dark:border-slate-700 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h1 className="text-lg font-bold">ቻት {unreadTotal > 0 && <span className="ml-1 rounded-full bg-teal-600 px-2 py-0.5 text-xs text-white">{unreadTotal}</span>}</h1>
            <span className="truncate text-xs text-slate-500" title="This agency">{me?.name}</span>
          </div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search agencies…"
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {pinned.map(c => (
            <ChatRow key={c.id} active={open?.id === c.id} kind={c.kind} title={c.kind === 'admin' ? 'Adal Keep' : c.title}
              sub={c.kind === 'admin' ? (c.last_body || 'Support, payments — talk to Adal') : (c.last_body || 'All agencies')}
              time={c.last_body || c.last_has_image ? c.last_message_at : null} unread={c.unread}
              onClick={() => setOpen({ id: c.id, kind: c.kind, title: c.kind === 'admin' ? 'Adal Keep' : 'Everyone' })} />
          ))}
          <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Agencies</p>
          {others.map(a => {
            const c = directs[a.id]
            return (
              <ChatRow key={a.id} active={open && c && open.id === c.id} kind="direct" title={a.name}
                sub={a.banned ? 'blocked by Adal' : c?.last_body || (c?.last_has_image ? '📷 Picture' : 'Start a private chat')}
                time={c?.last_body || c?.last_has_image ? c.last_message_at : null} unread={c?.unread} onClick={() => openAgency(a)} />
            )
          })}
          {others.length === 0 && <p className="px-4 py-6 text-sm text-slate-400">{q ? 'No agency with that name.' : 'No other agency has joined yet.'}</p>}
        </div>
      </aside>

      {/* -------------------------------------------------------- thread */}
      <section
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={e => { if (open && Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); setDragging(true) } }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { if (!open) return; e.preventDefault(); setDragging(false); takePicture(e.dataTransfer.files?.[0]) }}
      >
        {!open ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center text-slate-500">
            <div className="text-5xl">💬</div>
            <p className="mt-3 font-semibold text-slate-700 dark:text-slate-200">Choose a chat</p>
            <p className="text-sm">Everyone, Adal Keep, or any agency on the left.</p>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-3 border-b border-slate-200 dark:border-slate-700 px-5 py-3">
              <Avatar name={open.title} kind={open.kind} />
              <div>
                <p className="font-bold">{open.title}</p>
                <p className="text-xs text-slate-500">
                  {open.kind === 'group' ? `${agencies.filter(a => !a.is_admin).length} agencies` : open.kind === 'admin' ? 'Support and payments' : 'Private chat'}
                </p>
              </div>
            </header>

            <div ref={threadRef} className="flex-1 space-y-1.5 overflow-y-auto bg-slate-50 dark:bg-slate-950/40 px-5 py-4">
              {msgs.length === 0 && <p className="mt-10 text-center text-sm text-slate-400">No messages yet — say hello.</p>}
              {msgs.map((m, i) => {
                const mine = m.sender_id === me?.id
                const showName = open.kind === 'group' && !mine && msgs[i - 1]?.sender_id !== m.sender_id
                return (
                  <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] rounded-2xl px-3 py-2 shadow-sm ${mine ? 'rounded-br-md bg-teal-600 text-white' : 'rounded-bl-md bg-white dark:bg-slate-800'}`}>
                      {showName && <p className="mb-0.5 text-xs font-bold text-teal-700 dark:text-teal-300">{names[m.sender_id] || 'Agency'}</p>}
                      {m.image_path && (
                        <a href={`/api/chat/image?path=${encodeURIComponent(m.image_path)}`} target="_blank" rel="noreferrer">
                          <img src={`/api/chat/image?path=${encodeURIComponent(m.image_path)}`} alt="" className="mb-1 max-h-72 rounded-lg" />
                        </a>
                      )}
                      {m.body && <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>}
                      <p className={`mt-0.5 text-right text-[10px] ${mine ? 'text-teal-100' : 'text-slate-400'}`}>{timeOf(m.created_at)}</p>
                    </div>
                  </div>
                )
              })}
            </div>

            {me?.banned && open.kind !== 'admin' ? (
              <p className="border-t border-slate-200 dark:border-slate-700 bg-red-50 dark:bg-red-900/20 px-5 py-3 text-sm text-red-700 dark:text-red-300">
                Adal blocked this agency from writing here. You can still write to Adal Keep.
              </p>
            ) : (
              <div className="border-t border-slate-200 dark:border-slate-700 px-4 py-3">
                {pic && (
                  <div className="mb-2 flex items-center gap-3 rounded-lg bg-slate-100 dark:bg-slate-800 p-2 text-sm">
                    <img src={picUrl} alt="" className="h-12 w-12 rounded object-cover" />
                    <span className="flex-1 truncate">{pic.name}</span>
                    <button type="button" className="text-red-600 hover:underline" onClick={() => setPic(null)}>remove</button>
                  </div>
                )}
                {hasLink && <p className="mb-1 text-xs text-red-600">Links are not allowed in the chat — remove the link to send.</p>}
                <div className="flex items-end gap-2">
                  <button type="button" title="Send a picture" onClick={() => fileRef.current?.click()}
                    className="h-10 w-10 shrink-0 rounded-full text-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">📎</button>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => { takePicture(e.target.files?.[0]); e.target.value = '' }} />
                  <textarea
                    rows={1}
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                    onPaste={e => { const f = e.clipboardData?.files?.[0]; if (f) { e.preventDefault(); e.stopPropagation(); takePicture(f) } }}
                    placeholder="Write a message…"
                    className="max-h-40 min-h-[40px] flex-1 resize-none rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
                  />
                  <button type="button" onClick={send} disabled={sending || hasLink || (!text.trim() && !pic)}
                    className="h-10 shrink-0 rounded-full bg-teal-600 px-5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-40">
                    {sending ? '…' : 'Send'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-4 border-dashed border-teal-500 bg-teal-500/10 text-lg font-bold text-teal-700">
            Drop the picture to send it
          </div>
        )}
      </section>
    </div>
  )
}

function ChatRow({ active, kind, title, sub, time, unread, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${active ? 'bg-teal-50 dark:bg-teal-900/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
      <Avatar name={title} kind={kind} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold">{title}</span>
          {time && <span className="shrink-0 text-[10px] text-slate-400">{timeOf(time)}</span>}
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-slate-500">{sub}</span>
          {Number(unread) > 0 && <span className="shrink-0 rounded-full bg-teal-600 px-1.5 text-[10px] font-bold text-white">{unread}</span>}
        </span>
      </span>
    </button>
  )
}
