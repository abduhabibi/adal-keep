/**
 * The instant link to the agency's PC (Supabase Realtime, a websocket) —
 * the phone side of adal-keep-backend services/liveChannel.js.
 * Calls are answered in a fraction of a second; a run's tab streams as it
 * changes. Every message carries this phone's sign-in, which the PC checks.
 */
const listeners = new Set()
let ch = null, pcSeen = 0, ref = 0

export const pcLive = () => Date.now() - pcSeen < 25000
export function onLive(fn) { listeners.add(fn); return () => listeners.delete(fn) }

/** Connect once (the channel name is the agency's live secret). */
export function connectLive({ url, anon, live, token }) {
  if (ch || !live || typeof WebSocket === 'undefined') return
  const topic = `realtime:keep-${live}`
  const state = { ws: null, joined: false, token }
  ch = state
  const push = (t, event, payload) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify({ topic: t, event, payload, ref: String(++ref), join_ref: t === topic ? '1' : undefined }))
  const open = () => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${anon}&vsn=1.0.0`)
    state.ws = ws
    ws.onopen = () => {
      push(topic, 'phx_join', { config: { broadcast: { self: false }, presence: { key: '' }, private: false }, access_token: anon })
      const beat = () => push('phoenix', 'heartbeat', {}); beat.__always = true
      state.beat = setInterval(beat, 25000)
    }
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      if (m.event === 'phx_reply' && m.topic === topic && m.payload?.status === 'ok') state.joined = true
      if (m.event !== 'broadcast' || m.payload?.event !== 'm') return
      const msg = m.payload.payload || {}
      if (msg.t === 'pc') {
        const was = pcLive(); pcSeen = Date.now()
        if (!was) try { window.dispatchEvent(new CustomEvent('adal-pc-online', { detail: true })) } catch {}
      }
      listeners.forEach(fn => { try { fn(msg) } catch {} })
    }
    ws.onclose = () => { clearInterval(state.beat); state.joined = false; setTimeout(open, 2500) }
    ws.onerror = () => {}
  }
  state.send = async (msg) => state.joined && push(topic, 'broadcast', { type: 'broadcast', event: 'm', payload: { ...msg, jwt: await state.token() } })
  open()
}

export const liveReady = () => !!ch?.joined && pcLive()
export const sendLive = (msg) => ch?.send?.(msg)

/** An API call through the live link: resolves with the PC's answer, or null after `ms`. */
export function liveCall(method, path, body, ms = 9000) {
  if (!liveReady()) return Promise.resolve(null)
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve) => {
    const off = onLive((m) => { if (m.t === 'answer' && m.id === id) { off(); clearTimeout(timer); resolve(m) } })
    const timer = setTimeout(() => { off(); resolve(null) }, ms)
    sendLive({ t: 'call', id, method: method.toUpperCase(), path, body: body ?? null })
  })
}
