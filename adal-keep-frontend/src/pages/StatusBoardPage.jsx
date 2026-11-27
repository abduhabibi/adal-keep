import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { profilesList, lastProfiles } from '../lib/profilesCache'
import { onDataChange } from '../lib/changes'
import { STATUSES, columns, columnOf, needsFirst, boardOn, boardAsked } from '../lib/statusBoard'

/**
 * The status board (the owner, 2026-11-27): one column per status, each girl a card. A card dragged onto
 * another column takes that status at once, is saved behind (the profile page's own change: history, the
 * online copy, the robots' tasks), and the toast has Undo for 3 s. A status that needs something first says
 * so on the card, and the card stays. Mouse and touch (a touch drag starts after a short hold, so the
 * column still scrolls). 2,000 girls: from the list this window has (lib/profilesCache), each column draws
 * only the cards in sight. A card's ⋯: her page, or her AI Actions.
 * Off: ADAL_STATUS_BOARD=0, ?adal_off=board.
 */
const CARD_H = 68 // px a card takes, with its gap
const HOLD_MS = 220 // a touch drag starts after this hold

// Her page, scrolled to its AI Actions once it is drawn (the page does not scroll to #ai-actions by itself).
function toAiActions(navigate, id) {
  navigate(`/profiles/${id}#ai-actions`)
  let n = 0
  const look = () => {
    const el = document.getElementById('ai-actions')
    if (el && location.pathname === `/profiles/${id}`) return el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (++n < 50) setTimeout(look, 100)
  }
  setTimeout(look, 50)
}

function Column({ status, cards, onCardDown, hot, note, menuFor, setMenuFor, navigate }) {
  const box = useRef(null)
  const [top, setTop] = useState(0)
  const [h, setH] = useState(600)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const size = () => setH(el.clientHeight || 600)
    size()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])
  const from = Math.max(0, Math.floor(top / CARD_H) - 4)
  const to = Math.min(cards.length, Math.ceil((top + h) / CARD_H) + 4)
  return (
    <section data-status={status.value} className={`flex w-64 shrink-0 flex-col rounded-2xl border bg-slate-50 dark:bg-slate-900/60 ${hot ? 'border-teal-500 ring-2 ring-teal-400/50' : 'border-slate-200 dark:border-slate-700'}`}>
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${status.className}`}>{status.label}</span>
        <span className="text-xs text-slate-500" data-count>{cards.length}</span>
      </header>
      <div ref={box} onScroll={e => setTop(e.currentTarget.scrollTop)} className="min-h-[120px] flex-1 overflow-y-auto px-2 pb-2" style={{ maxHeight: 'calc(100vh - 220px)' }}>
        <div style={{ height: cards.length * CARD_H, position: 'relative' }}>
          {cards.slice(from, to).map((p, i) => {
            const n = from + i
            return (
              <div key={p.id} data-card={p.id} onPointerDown={e => onCardDown(e, p)}
                style={{ position: 'absolute', top: n * CARD_H, left: 0, right: 0, height: CARD_H - 8, touchAction: 'pan-y' }}
                className="select-none rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm dark:border-slate-700 dark:bg-slate-800 cursor-grab">
                <div className="flex items-start justify-between gap-1">
                  <span className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100" title={p.full_name}>{p.full_name || '—'}</span>
                  <button type="button" aria-label="More" data-menu
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => setMenuFor(menuFor === p.id ? null : p.id)}
                    className="-mr-1 rounded px-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700">⋯</button>
                </div>
                {note?.id === p.id
                  ? <span className="block truncate text-[11px] font-medium text-amber-600" data-note>{note.text}</span>
                  : <span className="block truncate text-[11px] text-slate-500">{p.passport_number || 'No passport number'}{p.broker_name ? ` · ${p.broker_name}` : ''}</span>}
                {menuFor === p.id && (
                  <div className="absolute right-2 top-7 z-20 w-44 rounded-lg border bg-white py-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-800" onPointerDown={e => e.stopPropagation()}>
                    <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => navigate(`/profiles/${p.id}`)}>Open her page</button>
                    <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-700" data-ai onClick={() => toAiActions(navigate, p.id)}>✨ AI Actions for her</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export default function StatusBoardPage() {
  const navigate = useNavigate()
  const [list, setList] = useState(() => lastProfiles() || null)
  const [on, setOn] = useState(boardOn())
  const [drag, setDrag] = useState(null)   // { p, x, y, over }
  const [note, setNote] = useState(null)   // { id, text }: why a card did not move
  const [menuFor, setMenuFor] = useState(null)
  const moved = useRef(new Map())          // id → status this window set, until the list has it

  const load = useCallback(({ fresh = false } = {}) => profilesList({ fresh }).then(d => {
    const m = moved.current
    setList((d || []).map(p => (m.has(p.id) ? (m.get(p.id) === p.status ? (m.delete(p.id), p) : { ...p, status: m.get(p.id) }) : p)))
  }).catch(() => setList(l => l || [])), [])
  useEffect(() => { boardAsked().then(setOn); load() }, [load])
  useEffect(() => onDataChange(['profiles'], () => load({ fresh: true })), [load])

  const cols = useMemo(() => columns(list), [list])

  const setStatus = useCallback(async (p, to, { undo = true } = {}) => {
    const from = p.status
    moved.current.set(p.id, to)
    setList(l => l.map(x => (x.id === p.id ? { ...x, status: to } : x)))
    const back = () => setStatus({ ...p, status: to }, from, { undo: false })
    try {
      // Once more after a second when the PC was busy (its database a moment locked, the line gone a moment).
      await api.put(`/profiles/${p.id}`, { status: to }).catch(async (e) => {
        if (e?.response && e.response.status < 500) throw e
        await new Promise(r => setTimeout(r, 1000))
        return api.put(`/profiles/${p.id}`, { status: to })
      })
      if (undo) {
        const label = STATUSES.find(s => s.value === to)?.label || to
        toast(t => (
          <span className="flex items-center gap-3 text-sm">
            <span><b>{p.full_name}</b> → {label}</span>
            <button type="button" className="rounded-md bg-slate-800 px-2 py-1 text-xs font-semibold text-white" onClick={() => { toast.dismiss(t.id); back() }}>Undo</button>
          </span>
        ), { duration: 3000, id: `board-${p.id}` })
      }
    } catch (e) {
      moved.current.delete(p.id)
      setList(l => l.map(x => (x.id === p.id ? { ...x, status: from } : x)))
      toast.error(e?.response?.data?.error || `${p.full_name}: not saved — she stays where she was`)
    }
  }, [])

  // The drag: mouse at once after a few pixels; touch after a short hold (a quick swipe scrolls the column).
  const onCardDown = useCallback((e, p) => {
    if (e.button && e.button !== 0) return
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen'
    const x0 = e.clientX, y0 = e.clientY
    let started = false, held = !touch, timer = null, last = { x: x0, y: y0 }
    const over = (x, y) => document.elementFromPoint(x, y)?.closest?.('[data-status]')?.getAttribute('data-status') || null
    const start = () => { started = true; setMenuFor(null); setNote(null); setDrag({ p, x: last.x, y: last.y, over: over(last.x, last.y) }) }
    if (touch) timer = setTimeout(() => { held = true; if (Math.hypot(last.x - x0, last.y - y0) < 10) start() }, HOLD_MS)
    const move = (ev) => {
      last = { x: ev.clientX, y: ev.clientY }
      if (!held) { if (Math.hypot(last.x - x0, last.y - y0) > 10) end() ; return }   // a swipe: the column scrolls
      if (!started && Math.hypot(last.x - x0, last.y - y0) > 6) start()
      if (started) { ev.preventDefault(); setDrag(d => d && { ...d, x: last.x, y: last.y, over: over(last.x, last.y) }) }
    }
    const up = (ev) => {
      end()
      if (!started) return
      const to = over(ev.clientX, ev.clientY)
      setDrag(null)
      if (!to || to === columnOf(p)) return
      const why = needsFirst(p, to)
      if (why) { setNote({ id: p.id, text: why }); toast(`${p.full_name}: ${why}`, { icon: '⚠️' }); return }
      setStatus(p, to)
    }
    const end = () => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
    const cancel = () => { end(); setDrag(null) }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }, [setStatus])
  useEffect(() => {
    if (!drag) return
    // While a card is dragged on a touch screen, the page does not scroll under the finger.
    const stop = (e) => e.preventDefault()
    document.addEventListener('touchmove', stop, { passive: false })
    return () => document.removeEventListener('touchmove', stop)
  }, [!!drag])
  useEffect(() => {
    if (menuFor == null) return
    const close = (e) => { if (!e.target.closest?.('[data-menu]') && !e.target.closest?.('[data-ai]')) setMenuFor(null) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuFor])

  if (!on) return <div className="p-6 text-sm text-slate-500">The status board is switched off on this PC.</div>
  return (
    <div className={drag ? 'cursor-grabbing' : ''}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 className="font-display text-xl font-bold">Profiles by status</h1>
        <button type="button" className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800" onClick={() => navigate('/profiles')}>List</button>
      </div>
      {!list && <p className="text-sm text-slate-500">Opening the profiles…</p>}
      {list && (
        <div className="flex gap-3 overflow-x-auto pb-3" data-board>
          {STATUSES.map(s => (
            <Column key={s.value} status={s} cards={cols[s.value]} onCardDown={onCardDown} hot={drag?.over === s.value && drag.over !== columnOf(drag.p)}
              note={note} menuFor={menuFor} setMenuFor={setMenuFor} navigate={navigate} />
          ))}
        </div>
      )}
      {drag && (
        <div className="pointer-events-none fixed z-50 w-60 rotate-2 rounded-xl border border-teal-400 bg-white px-3 py-2 text-sm font-semibold shadow-xl dark:bg-slate-800"
          style={{ left: drag.x - 40, top: drag.y - 20 }}>{drag.p.full_name}</div>
      )}
    </div>
  )
}
