import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

/**
 * Chat between every agency that runs Adal Keep — works like Telegram:
 * Everyone, an inbox with Adal, private chats, own groups (members, admins),
 * reply / edit / delete / forward / pin, pictures, documents, voice notes,
 * ✓ sent ✓✓ seen, online / last seen, typing…, search. No links.
 */
const LINK = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|[a-z0-9-]+\.(com|net|org|io|me|et|sa|ae|kw|qa|info|biz|co|app|link|xyz|ly|gl|site|online|shop)(\/|\s|$))/i
const fileUrl = (p, name) => `/api/chat/file?path=${encodeURIComponent(p)}${name ? `&name=${encodeURIComponent(name)}` : ''}`

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString()
const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const shortWhen = (t) => {
  const d = new Date(t), now = new Date()
  if (sameDay(d, now)) return timeOf(t)
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (sameDay(d, y)) return 'Yesterday'
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}
const dayLabel = (t) => {
  const d = new Date(t), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return 'Today'
  if (sameDay(d, y)) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}
const ONLINE_MS = 75 * 1000
function presence(lastSeen, now) {
  if (!lastSeen) return ''
  const ago = now - new Date(lastSeen).getTime()
  if (ago < ONLINE_MS) return 'online'
  const m = Math.round(ago / 60000)
  if (m < 60) return `last seen ${m} min ago`
  if (sameDay(lastSeen, now)) return `last seen today at ${timeOf(lastSeen)}`
  return `last seen ${shortWhen(lastSeen)}`
}
const sizeOf = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const preview = (m) => !m ? '' : m.deleted_at ? 'Message deleted' : m.kind === 'image' ? `📷 ${m.body || 'Picture'}` : m.kind === 'voice' ? '🎤 Voice message' : m.kind === 'file' ? `📎 ${m.file_name || 'File'}` : (m.body || '')

const SIZES = { 8: 'h-8 w-8', 10: 'h-10 w-10' }
function Avatar({ name, kind, size = 10, online }) {
  const bg = kind === 'everyone' ? 'bg-gradient-to-br from-teal-500 to-sky-500'
    : kind === 'admin' ? 'bg-gradient-to-br from-violet-500 to-pink-500'
    : kind === 'group' ? 'bg-gradient-to-br from-amber-500 to-orange-500' : 'bg-slate-400 dark:bg-slate-600'
  const letter = kind === 'everyone' ? '👥' : kind === 'admin' ? 'A' : (name || '?').trim()[0]?.toUpperCase()
  return (
    <span className={`relative flex ${SIZES[size] || SIZES[10]} shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${bg}`}>
      {letter}
      {online && <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-emerald-500 dark:border-slate-900" />}
    </span>
  )
}

// Yes/No asked inside the page (a browser can be told to stop showing its
// own confirm boxes, which then silently answer No).
let askHook = null
const askYes = (text) => (askHook ? askHook(text) : Promise.resolve(window.confirm(text)))
function AskHost() {
  const [q, setQ] = useState(null)
  useEffect(() => { askHook = (text) => new Promise(res => setQ({ text, res })); return () => { askHook = null } }, [])
  if (!q) return null
  const done = (v) => { q.res(v); setQ(null) }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
        <p className="text-sm">{q.text}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => done(false)} className="rounded-lg border px-4 py-1.5 text-sm">Cancel</button>
          <button type="button" autoFocus onClick={() => done(true)} className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white">Yes</button>
        </div>
      </div>
    </div>
  )
}

export default function ChatPage() {
  const [status, setStatus] = useState(null)
  const [agencies, setAgencies] = useState([])
  const [convs, setConvs] = useState([])
  const [open, setOpen] = useState(null)          // conversation row (or a direct chat just opened)
  const [msgs, setMsgs] = useState([])
  const [members, setMembers] = useState([])
  const [typing, setTyping] = useState([])
  const [text, setText] = useState('')
  const [attach, setAttach] = useState(null)       // File
  const [replyTo, setReplyTo] = useState(null)     // message
  const [editing, setEditing] = useState(null)     // message
  const [menu, setMenu] = useState(null)           // { m, x, y }
  const [forwarding, setForwarding] = useState(null)
  const [info, setInfo] = useState(false)          // group info panel
  const [newGroup, setNewGroup] = useState(false)
  const [q, setQ] = useState('')
  const [found, setFound] = useState([])
  const [sending, setSending] = useState(false)
  const [rec, setRec] = useState(null)             // { recorder, chunks, t0 }
  const [now, setNow] = useState(Date.now())
  const [dragging, setDragging] = useState(false)
  const threadRef = useRef(null)
  const fileRef = useRef(null)
  const inputRef = useRef(null)
  const lastId = useRef(0)
  const since = useRef(null)
  const lastTypingSent = useRef(0)

  const me = status?.me
  const names = useMemo(() => Object.fromEntries(agencies.map(a => [a.id, a.is_admin ? 'Adal Keep' : a.name])), [agencies])
  const seenOf = useMemo(() => Object.fromEntries(agencies.map(a => [a.id, a.last_seen])), [agencies])

  // --- loading --------------------------------------------------------
  const loadSide = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api.get('/chat/conversations'), api.get('/chat/agencies')])
      setConvs(Array.isArray(c.data) ? c.data : []); setAgencies(Array.isArray(a.data) ? a.data : [])
    } catch (e) { setStatus(s => (s?.configured ? s : { error: e.response?.data?.error || e.message })) }
  }, [])
  useEffect(() => {
    api.get('/chat/status').then(r => setStatus(r.data)).catch(e => setStatus({ error: e.response?.data?.error || e.message }))
  }, [])
  useEffect(() => {
    if (!status?.configured) return
    loadSide()
    api.post('/chat/ping').catch(() => {})
    const t1 = setInterval(loadSide, 4000)
    const t2 = setInterval(() => api.post('/chat/ping').catch(() => {}), 30000)
    const t3 = setInterval(() => setNow(Date.now()), 15000)
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3) }
  }, [status?.configured, loadSide])

  // the open chat: messages (new + edited/deleted), typing, members
  useEffect(() => {
    if (!open?.id) return
    let alive = true
    lastId.current = 0; since.current = null
    setMsgs([]); setMembers([]); setTyping([]); setInfo(false)
    const pull = async () => {
      try {
        const { data } = await api.get('/chat/messages', { params: { conversation: open.id, after: lastId.current, since: since.current } })
        if (!alive) return
        since.current = data.now
        if (data.messages?.length) lastId.current = data.messages[data.messages.length - 1].id
        if (data.messages?.length || data.changed?.length) {
          setMsgs(cur => {
            const byId = new Map(cur.map(m => [m.id, m]))
            for (const m of [...(data.changed || []), ...(data.messages || [])]) byId.set(m.id, m)
            return [...byId.values()].sort((a, b) => a.id - b.id)
          })
        }
      } catch {}
    }
    const side = async () => {
      try {
        const [t, mem] = await Promise.all([api.get('/chat/typing', { params: { conversation: open.id } }), api.get(`/chat/groups/${open.id}/members`)])
        if (alive) { setTyping(Array.isArray(t.data) ? t.data : []); setMembers(Array.isArray(mem.data) ? mem.data : []) }
      } catch {}
    }
    pull(); side()
    const a = setInterval(pull, 2000), b = setInterval(side, 3000)
    return () => { alive = false; clearInterval(a); clearInterval(b) }
  }, [open?.id])

  useEffect(() => {
    const el = threadRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight
  }, [msgs.length])
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight }, [open?.id])

  // message search
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return }
    const t = setTimeout(() => api.get('/chat/search', { params: { q } }).then(r => setFound(Array.isArray(r.data) ? r.data : [])).catch(() => {}), 350)
    return () => clearTimeout(t)
  }, [q])

  // --- derived --------------------------------------------------------
  const convOf = (id) => convs.find(c => c.id === id)
  const current = open ? (convOf(open.id) || open) : null
  const isEveryone = !!current && (current.is_everyone ?? (current.kind === 'group' && current.title === 'Everyone' && !current.my_role))
  const isGroup = current?.kind === 'group' && !isEveryone
  // is_everyone comes with the new schema; before that, Everyone is the group with no role.
  const everyoneOf = (c) => !!(c?.is_everyone ?? (c?.kind === 'group' && c?.title === 'Everyone' && !c?.my_role))
  const kindOf = (c) => (everyoneOf(c) ? 'everyone' : c.kind)
  const iManage = isGroup && ['owner', 'admin'].includes(current?.my_role)
  const others = members.filter(m => m.agency_id !== me?.id)
  const seenUpTo = others.length ? Math.max(...others.map(m => Number(m.last_read_id || 0))) : 0
  const pinned = current?.pinned_message_id ? msgs.find(m => m.id === current.pinned_message_id) : null
  const canPin = current && (current.kind === 'direct' || iManage || (current.kind === 'admin'))

  const directs = Object.fromEntries(convs.filter(c => c.kind === 'direct').map(c => [c.other_id, c]))
  const term = q.trim().toLowerCase()
  const chatList = convs
    .filter(c => !term || String(c.title || '').toLowerCase().includes(term))
    .sort((a, b) => {
      const pin = (c) => (everyoneOf(c) ? 0 : c.kind === 'admin' ? 1 : 2)
      return pin(a) - pin(b) || new Date(b.last_message_at) - new Date(a.last_message_at)
    })
  const newAgencies = agencies.filter(a => !a.is_admin && a.id !== me?.id && !directs[a.id] && (!term || a.name.toLowerCase().includes(term)))
  const unreadTotal = convs.reduce((n, c) => n + Number(c.unread || 0), 0)

  const subtitle = () => {
    if (!current) return ''
    const who = typing.map(t => t.name)
    if (who.length) return current.kind === 'direct' ? 'typing…' : `${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} typing…`
    if (current.kind === 'direct') return presence(current.other_last_seen || seenOf[current.other_id], now) || 'private chat'
    if (current.kind === 'admin') return 'Support and payments'
    const online = members.filter(m => m.agency_id !== me?.id && now - new Date(m.last_seen).getTime() < ONLINE_MS).length
    return `${members.length || current.member_count || ''} members${online ? `, ${online} online` : ''}`
  }

  // --- actions --------------------------------------------------------
  const openAgency = async (a) => {
    const c = directs[a.id]
    if (c) return setOpen(c)
    try { const { data } = await api.post(`/chat/direct/${a.id}`); setOpen({ id: data.id, kind: 'direct', title: a.name, other_id: a.id }); loadSide() }
    catch (e) { toast.error(e.response?.data?.error || 'Could not open the chat') }
  }

  const hasLink = LINK.test(text)
  const send = async () => {
    if (!current || sending || hasLink) return
    if (editing) {
      if (!text.trim()) return
      setSending(true)
      try { await api.post(`/chat/messages/${editing.id}/edit`, { body: text }); setEditing(null); setText('') }
      catch (e) { toast.error(e.response?.data?.error || 'Not edited') } finally { setSending(false) }
      return
    }
    if (!text.trim() && !attach) return
    setSending(true)
    try {
      const fd = new FormData()
      fd.append('conversation', current.id)
      fd.append('body', text.trim())
      if (replyTo) fd.append('reply_to', replyTo.id)
      if (attach) fd.append('file', attach, attach.name || 'file')
      const { data } = await api.post('/chat/send', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      if (data?.id) setMsgs(m => (m.some(x => x.id === data.id) ? m : [...m, data].sort((a, b) => a.id - b.id)))
      setText(''); setAttach(null); setReplyTo(null)
      setTimeout(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight }, 50)
      loadSide()
    } catch (e) { toast.error(e.response?.data?.error || 'Not sent') } finally { setSending(false) }
  }

  const onType = (v) => {
    setText(v)
    if (current && Date.now() - lastTypingSent.current > 3000) {
      lastTypingSent.current = Date.now()
      api.post('/chat/typing', { conversation: current.id }).catch(() => {})
    }
  }

  const takeFile = (f) => {
    if (!f) return
    if (f.size > 20 * 1024 * 1024) return toast.error('Files up to 20 MB.')
    setAttach(f); inputRef.current?.focus()
  }

  // voice notes (needs the microphone; works on this PC and over https)
  const startVoice = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return toast.error('Voice messages need the microphone (on this PC, or over the secure link).')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      const chunks = []
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      recorder.start()
      setRec({ recorder, chunks, stream, t0: Date.now() })
    } catch { toast.error('The microphone is not available.') }
  }
  const stopVoice = async (sendIt) => {
    const r = rec; setRec(null)
    if (!r) return
    await new Promise(res => { r.recorder.onstop = res; r.recorder.stop() })
    r.stream.getTracks().forEach(t => t.stop())
    if (!sendIt || !current) return
    const blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' })
    if (blob.size < 1500) return
    const fd = new FormData()
    fd.append('conversation', current.id); fd.append('kind', 'voice'); fd.append('body', '')
    if (replyTo) fd.append('reply_to', replyTo.id)
    fd.append('file', blob, `voice-${Date.now()}.webm`)
    try { await api.post('/chat/send', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); setReplyTo(null); loadSide() }
    catch (e) { toast.error(e.response?.data?.error || 'Voice message not sent') }
  }

  const act = async (what, m) => {
    setMenu(null)
    try {
      if (what === 'reply') { setEditing(null); setReplyTo(m); inputRef.current?.focus() }
      if (what === 'edit') { setReplyTo(null); setEditing(m); setText(m.body || ''); inputRef.current?.focus() }
      if (what === 'copy') { await navigator.clipboard.writeText(m.body || ''); toast.success('Copied') }
      if (what === 'forward') setForwarding(m)
      if (what === 'pin') { await api.post(`/chat/conversations/${current.id}/pin`, { message: m.id }); loadSide() }
      if (what === 'unpin') { await api.post(`/chat/conversations/${current.id}/pin`, { message: null }); loadSide() }
      if (what === 'delete') {
        if (!(await askYes('Delete this message for everyone?'))) return
        await api.post(`/chat/messages/${m.id}/delete`)
        setMsgs(cur => cur.map(x => (x.id === m.id ? { ...x, deleted_at: new Date().toISOString(), body: null, image_path: null, file_path: null } : x)))
      }
    } catch (e) { toast.error(e.response?.data?.error || 'Not done') }
  }

  const forwardTo = async (convId) => {
    const m = forwarding; setForwarding(null)
    const fd = new FormData(); fd.append('conversation', convId); fd.append('forward', m.id); fd.append('body', '')
    try { await api.post('/chat/send', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); toast.success('Forwarded'); loadSide() }
    catch (e) { toast.error(e.response?.data?.error || 'Not forwarded') }
  }

  const jumpTo = (id) => {
    const el = document.getElementById(`msg-${id}`)
    if (!el) return toast('That message is further up.')
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('ring-2', 'ring-teal-400'); setTimeout(() => el.classList.remove('ring-2', 'ring-teal-400'), 1500)
  }

  // --- render ---------------------------------------------------------
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

  const byId = Object.fromEntries(msgs.map(m => [m.id, m]))

  return (
    <div className="flex h-full min-h-0 bg-white dark:bg-slate-900" onClick={() => menu && setMenu(null)}>
      <AskHost />
      {/* ======================================================= chat list */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200 dark:border-slate-700 min-h-0">
        <div className="border-b border-slate-200 dark:border-slate-700 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold">ቻት {unreadTotal > 0 && <span className="ml-1 rounded-full bg-teal-600 px-2 py-0.5 text-xs text-white">{unreadTotal}</span>}</h1>
            <button type="button" onClick={() => setNewGroup(true)} className="rounded-full bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700">+ New group</button>
          </div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search chats, agencies, messages…"
            className="w-full rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40" />
          <p className="truncate text-[11px] text-slate-400" title="This agency">You are: {me?.name}</p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {chatList.map(c => (
            <ChatRow key={c.id} active={current?.id === c.id} kind={kindOf(c)} title={c.title || 'Chat'}
              online={c.kind === 'direct' && now - new Date(c.other_last_seen || seenOf[c.other_id] || 0).getTime() < ONLINE_MS}
              sub={c.last_kind === 'voice' ? '🎤 Voice message' : c.last_kind === 'file' ? `📎 ${c.last_body || 'File'}` : c.last_has_image ? `📷 ${c.last_body || 'Picture'}` : (c.last_body || (c.kind === 'admin' ? 'Support, payments — talk to Adal' : c.kind === 'group' ? `${c.member_count || ''} members` : ''))}
              time={c.last_body || c.last_has_image || c.last_kind ? c.last_message_at : null} unread={c.unread}
              onClick={() => setOpen(c)} />
          ))}
          {newAgencies.length > 0 && <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Agencies — start a chat</p>}
          {newAgencies.map(a => (
            <ChatRow key={a.id} kind="direct" title={a.name} online={now - new Date(a.last_seen || 0).getTime() < ONLINE_MS}
              sub={a.banned ? 'blocked by Adal' : presence(a.last_seen, now) || 'Start a private chat'} onClick={() => openAgency(a)} />
          ))}
          {found.length > 0 && (
            <>
              <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Messages</p>
              {found.map(f => {
                const c = convOf(f.conversation_id)
                return (
                  <button key={f.id} type="button" onClick={() => { setOpen(c || { id: f.conversation_id }); setTimeout(() => jumpTo(f.id), 900) }}
                    className="block w-full px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                    <span className="flex justify-between text-xs"><b className="truncate">{c?.title || 'Chat'}</b><span className="text-slate-400">{shortWhen(f.created_at)}</span></span>
                    <span className="block truncate text-xs text-slate-500">{names[f.sender_id] ? `${names[f.sender_id]}: ` : ''}{f.body}</span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      </aside>

      {/* ========================================================= thread */}
      <section className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={e => { if (current && Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); setDragging(true) } }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { if (!current) return; e.preventDefault(); setDragging(false); takeFile(e.dataTransfer.files?.[0]) }}>
        {!current ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center text-slate-500">
            <div className="text-5xl">💬</div>
            <p className="mt-3 font-semibold text-slate-700 dark:text-slate-200">Choose a chat</p>
            <p className="text-sm">Everyone, Adal Keep, your groups or any agency on the left.</p>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-3 border-b border-slate-200 dark:border-slate-700 px-5 py-2.5">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => isGroup && setInfo(v => !v)}>
                <Avatar name={current.title} kind={kindOf(current)} online={current.kind === 'direct' && subtitle() === 'online'} />
                <span className="min-w-0">
                  <span className="block truncate font-bold">{current.title}</span>
                  <span className={`block truncate text-xs ${/typing|online/.test(subtitle()) ? 'text-teal-600' : 'text-slate-500'}`}>{subtitle()}</span>
                </span>
              </button>
              {isGroup && <button type="button" onClick={() => setInfo(v => !v)} className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">Group info</button>}
            </header>

            {pinned && (
              <div className="flex items-center gap-2 border-b border-slate-200 bg-teal-50/60 px-5 py-1.5 text-xs dark:border-slate-700 dark:bg-teal-900/20">
                <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => jumpTo(pinned.id)}>
                  📌 <b className="text-teal-700 dark:text-teal-300">Pinned</b> · {preview(pinned)}
                </button>
                {canPin && <button type="button" className="text-slate-400 hover:text-red-600" onClick={() => act('unpin', pinned)}>✕</button>}
              </div>
            )}

            <div className="flex min-h-0 flex-1">
              <div ref={threadRef} className="flex-1 overflow-y-auto bg-[#eef3f1] px-4 py-3 dark:bg-slate-950/40">
                {msgs.length === 0 && <p className="mt-10 text-center text-sm text-slate-400">No messages yet — say hello.</p>}
                {msgs.map((m, i) => {
                  const mine = m.sender_id === me?.id
                  const prev = msgs[i - 1]
                  const newDay = !prev || !sameDay(prev.created_at, m.created_at)
                  const showName = current.kind !== 'direct' && !mine && (newDay || prev?.sender_id !== m.sender_id)
                  const quoted = m.reply_to ? byId[m.reply_to] : null
                  return (
                    <div key={m.id}>
                      {newDay && <div className="my-3 text-center"><span className="rounded-full bg-white/80 px-3 py-0.5 text-[11px] text-slate-500 shadow-sm dark:bg-slate-800">{dayLabel(m.created_at)}</span></div>}
                      <div className={`mb-1 flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div id={`msg-${m.id}`}
                          onContextMenu={e => { e.preventDefault(); if (!m.deleted_at) setMenu({ m, x: e.clientX, y: e.clientY }) }}
                          onDoubleClick={() => !m.deleted_at && act('reply', m)}
                          className={`group relative max-w-[72%] rounded-2xl px-3 py-1.5 shadow-sm transition ${mine ? 'rounded-br-md bg-[#d9fdd3] dark:bg-teal-800' : 'rounded-bl-md bg-white dark:bg-slate-800'}`}>
                          {showName && <p className="text-xs font-bold text-teal-700 dark:text-teal-300">{names[m.sender_id] || 'Agency'}</p>}
                          {m.forwarded_from && !m.deleted_at && <p className="text-[11px] italic text-sky-700 dark:text-sky-300">Forwarded from {m.forwarded_from}</p>}
                          {quoted && !m.deleted_at && (
                            <button type="button" onClick={() => jumpTo(quoted.id)} className="mb-1 block w-full rounded-md border-l-4 border-teal-500 bg-black/5 px-2 py-1 text-left dark:bg-white/10">
                              <span className="block text-[11px] font-bold text-teal-700 dark:text-teal-300">{quoted.sender_id === me?.id ? 'You' : names[quoted.sender_id] || 'Agency'}</span>
                              <span translate="no" className="block truncate text-xs text-slate-600 dark:text-slate-300">{preview(quoted)}</span>
                            </button>
                          )}
                          {m.deleted_at ? (
                            <p className="text-sm italic text-slate-400">🚫 Message deleted</p>
                          ) : (
                            <>
                              {m.image_path && (
                                <a href={fileUrl(m.image_path)} target="_blank" rel="noreferrer">
                                  <img src={fileUrl(m.image_path)} alt="" className="my-1 max-h-72 rounded-lg" />
                                </a>
                              )}
                              {m.kind === 'voice' && m.file_path && <audio controls preload="none" src={fileUrl(m.file_path)} className="my-1 h-10 w-64 max-w-full" />}
                              {m.kind === 'file' && m.file_path && (
                                <a href={fileUrl(m.file_path, m.file_name)} target="_blank" rel="noreferrer"
                                  className="my-1 flex items-center gap-3 rounded-lg bg-black/5 px-3 py-2 hover:bg-black/10 dark:bg-white/10">
                                  <span className="text-2xl">📄</span>
                                  <span className="min-w-0"><span className="block truncate text-sm font-semibold">{m.file_name}</span><span className="text-[11px] text-slate-500">{m.file_size ? sizeOf(m.file_size) : ''} · open</span></span>
                                </a>
                              )}
                              {m.body && <p translate="no" className="whitespace-pre-wrap break-words text-sm">{m.body}</p>}
                            </>
                          )}
                          <p className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-slate-500">
                            {m.edited_at && !m.deleted_at && <span>edited</span>}
                            <span>{timeOf(m.created_at)}</span>
                            {mine && !m.deleted_at && <span className={m.id <= seenUpTo ? 'text-sky-500' : ''} title={m.id <= seenUpTo ? 'Seen' : 'Sent'}>{m.id <= seenUpTo ? '✓✓' : '✓'}</span>}
                          </p>
                          {!m.deleted_at && (
                            <button type="button" onClick={e => { e.stopPropagation(); setMenu({ m, x: e.clientX, y: e.clientY }) }}
                              className="absolute -top-2 right-1 hidden rounded-full bg-white px-1.5 text-xs text-slate-500 shadow group-hover:block dark:bg-slate-700">⌄</button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {info && isGroup && (
                <GroupInfo conv={current} members={members} me={me} agencies={agencies} now={now}
                  onChanged={() => { loadSide(); api.get(`/chat/groups/${current.id}/members`).then(r => setMembers(Array.isArray(r.data) ? r.data : [])).catch(() => {}) }}
                  onLeft={() => { setOpen(null); loadSide() }} onClose={() => setInfo(false)} />
              )}
            </div>

            {/* composer */}
            {me?.banned && current.kind !== 'admin' ? (
              <p className="border-t border-slate-200 bg-red-50 px-5 py-3 text-sm text-red-700 dark:border-slate-700 dark:bg-red-900/20 dark:text-red-300">
                Adal blocked this agency from writing here. You can still write to Adal Keep.
              </p>
            ) : (
              <div className="border-t border-slate-200 px-4 py-2.5 dark:border-slate-700">
                {(replyTo || editing) && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg border-l-4 border-teal-500 bg-slate-100 px-3 py-1.5 text-xs dark:bg-slate-800">
                    <span className="min-w-0 flex-1 truncate">
                      <b className="text-teal-700 dark:text-teal-300">{editing ? 'Edit message' : `Reply to ${replyTo.sender_id === me?.id ? 'yourself' : names[replyTo.sender_id] || 'agency'}`}</b>
                      <span className="block truncate text-slate-500">{preview(editing || replyTo)}</span>
                    </span>
                    <button type="button" onClick={() => { setReplyTo(null); if (editing) { setEditing(null); setText('') } }} className="text-slate-400 hover:text-red-600">✕</button>
                  </div>
                )}
                {attach && (
                  <div className="mb-2 flex items-center gap-3 rounded-lg bg-slate-100 p-2 text-sm dark:bg-slate-800">
                    <span className="text-xl">{/^image\//.test(attach.type) ? '📷' : '📄'}</span>
                    <span className="min-w-0 flex-1 truncate">{attach.name} <span className="text-xs text-slate-500">· {sizeOf(attach.size)}</span></span>
                    <button type="button" className="text-red-600 hover:underline" onClick={() => setAttach(null)}>remove</button>
                  </div>
                )}
                {hasLink && <p className="mb-1 text-xs text-red-600">Links are not allowed in the chat — remove the link to send.</p>}
                {rec ? (
                  <div className="flex items-center gap-3">
                    <span className="h-3 w-3 animate-pulse rounded-full bg-red-500" />
                    <span className="flex-1 text-sm text-slate-600 dark:text-slate-300">Recording… {Math.round((now - rec.t0) / 1000)}s</span>
                    <button type="button" onClick={() => stopVoice(false)} className="text-sm text-slate-500 hover:underline">Cancel</button>
                    <button type="button" onClick={() => stopVoice(true)} className="h-10 rounded-full bg-teal-600 px-5 text-sm font-semibold text-white hover:bg-teal-700">Send voice</button>
                  </div>
                ) : (
                  <div className="flex items-end gap-2">
                    <button type="button" title="Send a picture or document" onClick={() => fileRef.current?.click()}
                      className="h-10 w-10 shrink-0 rounded-full text-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">📎</button>
                    <input ref={fileRef} type="file" className="hidden" onChange={e => { takeFile(e.target.files?.[0]); e.target.value = '' }} />
                    <textarea ref={inputRef} rows={1} value={text}
                      onChange={e => onType(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                        if (e.key === 'Escape') { setReplyTo(null); if (editing) { setEditing(null); setText('') } }
                        if (e.key === 'ArrowUp' && !text) { const last = [...msgs].reverse().find(x => x.sender_id === me?.id && !x.deleted_at && x.body); if (last) { e.preventDefault(); act('edit', last) } }
                      }}
                      onPaste={e => { const f = e.clipboardData?.files?.[0]; if (f) { e.preventDefault(); e.stopPropagation(); takeFile(f) } }}
                      placeholder={editing ? 'Edit the message…' : 'Write a message…'}
                      className="max-h-40 min-h-[40px] flex-1 resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 dark:border-slate-700 dark:bg-slate-800" />
                    {!text.trim() && !attach && !editing ? (
                      <button type="button" title="Record a voice message" onClick={startVoice}
                        className="h-10 w-10 shrink-0 rounded-full bg-teal-600 text-lg text-white hover:bg-teal-700">🎤</button>
                    ) : (
                      <button type="button" onClick={send} disabled={sending || hasLink}
                        className="h-10 shrink-0 rounded-full bg-teal-600 px-5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-40">
                        {sending ? '…' : editing ? 'Save' : 'Send'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-4 border-dashed border-teal-500 bg-teal-500/10 text-lg font-bold text-teal-700">
            Drop the file to send it
          </div>
        )}
      </section>

      {/* message menu */}
      {menu && (
        <div className="fixed z-50 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-800"
          style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 260) }} onClick={e => e.stopPropagation()}>
          {[
            ['reply', '↩ Reply', true],
            ['edit', '✏️ Edit', menu.m.sender_id === me?.id && menu.m.kind === 'text'],
            ['copy', '📋 Copy text', !!menu.m.body],
            ['forward', '↪ Forward', true],
            ['pin', current?.pinned_message_id === menu.m.id ? null : '📌 Pin', canPin && current?.pinned_message_id !== menu.m.id],
            ['unpin', '📌 Unpin', canPin && current?.pinned_message_id === menu.m.id],
            ['delete', '🗑 Delete', menu.m.sender_id === me?.id || iManage],
          ].filter(x => x[2]).map(([k, label]) => (
            <button key={k} type="button" onClick={() => act(k, menu.m)}
              className={`block w-full px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700 ${k === 'delete' ? 'text-red-600' : ''}`}>{label}</button>
          ))}
        </div>
      )}

      {forwarding && (
        <Picker title="Forward to…" onClose={() => setForwarding(null)}
          items={convs.map(c => ({ id: c.id, name: c.title || 'Chat', kind: kindOf(c) }))}
          onPick={(id) => forwardTo(id)} />
      )}
      {newGroup && (
        <NewGroup agencies={agencies.filter(a => !a.is_admin && a.id !== me?.id)} onClose={() => setNewGroup(false)}
          onMade={(id, title) => { setNewGroup(false); loadSide(); setOpen({ id, kind: 'group', title, my_role: 'owner' }) }} />
      )}
    </div>
  )
}

function ChatRow({ active, kind, title, sub, time, unread, online, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${active ? 'bg-teal-50 dark:bg-teal-900/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
      <Avatar name={title} kind={kind} online={online} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold">{title}</span>
          {time && <span className="shrink-0 text-[10px] text-slate-400">{shortWhen(time)}</span>}
        </span>
        <span className="flex items-center justify-between gap-2">
          <span translate="no" className="truncate text-xs text-slate-500">{sub}</span>
          {Number(unread) > 0 && <span className="shrink-0 rounded-full bg-teal-600 px-1.5 text-[10px] font-bold text-white">{unread}</span>}
        </span>
      </span>
    </button>
  )
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-white shadow-2xl dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <h3 className="font-bold">{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Picker({ title, items, onPick, onClose }) {
  const [q, setQ] = useState('')
  return (
    <Modal title={title} onClose={onClose}>
      <div className="p-3"><input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" /></div>
      <div className="overflow-y-auto pb-2">
        {items.filter(i => !q || i.name.toLowerCase().includes(q.toLowerCase())).map(i => (
          <button key={i.id} type="button" onClick={() => onPick(i.id)} className="flex w-full items-center gap-3 px-5 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
            <Avatar name={i.name} kind={i.kind} size={8} /><span className="truncate text-sm">{i.name}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

function AgencyChooser({ agencies, chosen, setChosen, exclude = [] }) {
  const [q, setQ] = useState('')
  const list = agencies.filter(a => !exclude.includes(a.id) && (!q || a.name.toLowerCase().includes(q.toLowerCase())))
  return (
    <>
      <div className="px-5 pt-3"><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search agencies…" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" /></div>
      <div className="flex-1 overflow-y-auto py-2">
        {list.map(a => (
          <label key={a.id} className="flex cursor-pointer items-center gap-3 px-5 py-2 hover:bg-slate-50 dark:hover:bg-slate-800">
            <input type="checkbox" className="accent-teal-600" checked={chosen.includes(a.id)}
              onChange={e => setChosen(c => (e.target.checked ? [...c, a.id] : c.filter(x => x !== a.id)))} />
            <Avatar name={a.name} kind="direct" size={8} /><span className="truncate text-sm">{a.name}</span>
          </label>
        ))}
        {list.length === 0 && <p className="px-5 py-4 text-sm text-slate-400">No agency to add.</p>}
      </div>
    </>
  )
}

function NewGroup({ agencies, onClose, onMade }) {
  const [title, setTitle] = useState('')
  const [chosen, setChosen] = useState([])
  const [busy, setBusy] = useState(false)
  const make = async () => {
    if (!title.trim()) return toast.error('Give the group a name.')
    setBusy(true)
    try { const { data } = await api.post('/chat/groups', { title, members: chosen }); onMade(data.id, title.trim()) }
    catch (e) { toast.error(e.response?.data?.error || 'Group not made') } finally { setBusy(false) }
  }
  return (
    <Modal title="New group" onClose={onClose}>
      <div className="px-5 pt-4"><input autoFocus value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder="Group name"
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold dark:border-slate-700 dark:bg-slate-800" /></div>
      <p className="px-5 pt-3 text-xs font-semibold uppercase text-slate-400">Members ({chosen.length})</p>
      <AgencyChooser agencies={agencies} chosen={chosen} setChosen={setChosen} />
      <div className="border-t border-slate-200 p-3 text-right dark:border-slate-700">
        <button type="button" disabled={busy} onClick={make} className="rounded-lg bg-teal-600 px-5 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">Create group</button>
      </div>
    </Modal>
  )
}

function GroupInfo({ conv, members, me, agencies, now, onChanged, onLeft, onClose }) {
  const mine = members.find(m => m.agency_id === me?.id)?.role || conv.my_role
  const manage = mine === 'owner' || mine === 'admin'
  const [adding, setAdding] = useState(false)
  const [chosen, setChosen] = useState([])
  const [title, setTitle] = useState(conv.title || '')
  const run = async (fn, okMsg) => { try { await fn(); if (okMsg) toast.success(okMsg); onChanged() } catch (e) { toast.error(e.response?.data?.error || 'Not done') } }
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <b>Group info</b><button type="button" onClick={onClose} className="text-slate-400">✕</button>
      </div>
      <div className="space-y-3 overflow-y-auto p-4">
        {manage ? (
          <div className="flex gap-2">
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={80} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" />
            <button type="button" className="rounded-lg border px-2 text-xs" onClick={() => run(() => api.post(`/chat/groups/${conv.id}/rename`, { title }), 'Renamed')}>Rename</button>
          </div>
        ) : <p className="text-lg font-bold">{conv.title}</p>}
        <p className="text-xs font-semibold uppercase text-slate-400">{members.length} members</p>
        {members.map(m => (
          <div key={m.agency_id} className="flex items-center gap-2">
            <Avatar name={m.name} kind="direct" size={8} online={now - new Date(m.last_seen).getTime() < ONLINE_MS} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{m.agency_id === me?.id ? 'You' : m.name}</span>
              <span className="text-[11px] text-slate-400">{m.role !== 'member' ? m.role : presence(m.last_seen, now)}</span>
            </span>
            {mine === 'owner' && m.role !== 'owner' && (
              <button type="button" className="text-[11px] text-teal-700 hover:underline"
                onClick={() => run(() => api.post(`/chat/groups/${conv.id}/admin`, { agency: m.agency_id, admin: m.role !== 'admin' }))}>{m.role === 'admin' ? 'not admin' : 'make admin'}</button>
            )}
            {manage && m.role !== 'owner' && m.agency_id !== me?.id && (
              <button type="button" className="text-[11px] text-red-600 hover:underline"
                onClick={async () => (await askYes(`Remove ${m.name} from the group?`)) && run(() => api.post(`/chat/groups/${conv.id}/remove`, { agency: m.agency_id }))}>remove</button>
            )}
          </div>
        ))}
        {manage && !adding && <button type="button" onClick={() => setAdding(true)} className="w-full rounded-lg bg-teal-600 py-2 text-sm font-semibold text-white">+ Add members</button>}
        {adding && (
          <div className="flex max-h-80 flex-col rounded-lg border border-slate-200 dark:border-slate-700">
            <AgencyChooser agencies={agencies.filter(a => !a.is_admin)} chosen={chosen} setChosen={setChosen} exclude={members.map(m => m.agency_id)} />
            <div className="flex justify-end gap-2 p-2">
              <button type="button" className="text-xs" onClick={() => { setAdding(false); setChosen([]) }}>Cancel</button>
              <button type="button" className="rounded-lg bg-teal-600 px-3 py-1 text-xs font-semibold text-white"
                onClick={() => run(async () => { await api.post(`/chat/groups/${conv.id}/members`, { members: chosen }); setAdding(false); setChosen([]) }, 'Added')}>Add {chosen.length}</button>
            </div>
          </div>
        )}
        <button type="button" className="w-full rounded-lg border border-red-200 py-2 text-sm text-red-600 hover:bg-red-50"
          onClick={async () => { if (!(await askYes('Leave this group?'))) return; try { await api.post(`/chat/groups/${conv.id}/remove`, { agency: me.id }); onLeft() } catch (e) { toast.error(e.response?.data?.error || 'Not done') } }}>
          Leave group
        </button>
      </div>
    </aside>
  )
}
