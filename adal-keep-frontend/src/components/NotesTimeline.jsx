/**
 * A profile's notes, readable: the runs write dated lines
 *   "[2026-10-27] Visa: form filled — waiting for a person … (also to fill: A; B (choices: …))"
 * shown here as a timeline — newest day first, each line with its portal's
 * icon and colour, a status badge (Needs you · Done · FIT · Problem), the
 * "also to fill" items as chips, and the same line repeated shown once (×3).
 * Only a portal's newest "waiting for a person" pulses; older ones say Earlier.
 * Lines a person typed (no date) stay at the top as they were written.
 */
import { useMemo } from 'react'

const PORTALS = [
  [/^insurance/i, '🛡️', 'Insurance', 'from-amber-400 to-orange-500', 'text-amber-700 dark:text-amber-300'],
  [/^visa|enjaz/i, '🛂', 'Visa', 'from-indigo-400 to-violet-500', 'text-indigo-700 dark:text-indigo-300'],
  [/^musaned/i, '🤝', 'Musaned', 'from-teal-400 to-emerald-500', 'text-teal-700 dark:text-teal-300'],
  [/^wafid|medical/i, '🩺', 'Wafid medical', 'from-sky-400 to-cyan-500', 'text-sky-700 dark:text-sky-300'],
  [/^lmis|labou?r/i, '🏛️', 'LMIS', 'from-blue-400 to-blue-600', 'text-blue-700 dark:text-blue-300'],
  [/^police/i, '👮', 'Police', 'from-slate-400 to-slate-600', 'text-slate-700 dark:text-slate-300'],
  [/^contract/i, '📄', 'Contract', 'from-fuchsia-400 to-pink-500', 'text-fuchsia-700 dark:text-fuchsia-300'],
  [/^whatsapp/i, '💬', 'WhatsApp', 'from-green-400 to-green-600', 'text-green-700 dark:text-green-300'],
]
const OTHER = ['📝', '', 'from-slate-300 to-slate-400', 'text-slate-600 dark:text-slate-300']

const STATUS = {
  need: ['Needs you', 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', true],
  bad: ['Problem', 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'],
  fit: ['FIT', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'],
  done: ['Done', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'],
  info: ['Info', 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'],
  past: ['Earlier', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'],
}
const statusOf = (t) => /\bUNFIT\b|failed|rejected|not found|error/i.test(t) ? 'bad'
  : /waiting for (a person|you)|a person (types|presses|adds)|needs? (you|a person)/i.test(t) ? 'need'
  : /\bFIT\b/.test(t) ? 'fit'
  : /already registered|not added again|nothing/i.test(t) ? 'info'
  : /done|created|saved|applied|made|added|chosen|booked/i.test(t) ? 'done' : 'info'

/** "Name (choices: a, b); Other" → [{ name, choices }] */
function splitToFill(s) {
  const out = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map(x => {
    const m = x.match(/^\s*([^(]+?)\s*(?:\(choices:\s*(.*)\))?\s*$/)
    const choices = [...new Set((m?.[2] || '').split(',').map(c => c.trim()).filter(Boolean))]
    return { name: (m?.[1] || x).trim(), choices }
  }).filter(x => x.name)
}

function parse(notes) {
  const free = [], days = new Map()
  for (const raw of String(notes || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/)
    if (!m) { free.push(line); continue }
    let [, date, text] = m
    // "(also to fill: …)" at the end → chips.
    let toFill = []
    const k = text.search(/\(also to fill:/i)
    if (k >= 0) { toFill = splitToFill(text.slice(k).replace(/^\(also to fill:\s*/i, '').replace(/\)\s*$/, '')); text = text.slice(0, k).trim() }
    const c = text.indexOf(':')
    const head = c > 0 && c < 30 ? text.slice(0, c).trim() : ''
    const portal = PORTALS.find(([re]) => re.test(head || text))
    const body = head && portal ? text.slice(c + 1).trim() : text
    const key = `${portal?.[2] || head}|${body}|${toFill.map(t => t.name).join(';')}`
    if (!days.has(date)) days.set(date, [])
    const list = days.get(date)
    const same = list.find(e => e.key === key)
    if (same) { same.times++; continue }
    list.push({ key, portal, head, body, toFill, status: statusOf(text), times: 1 })
  }
  // Newest first; a "Needs you" that a newer line of the same portal follows is history.
  const sorted = [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, l]) => [d, l.reverse()])
  const seen = new Set()
  for (const [, list] of sorted) for (const e of list) {
    const p = e.portal?.[2] || e.head
    if (e.status === 'need' && seen.has(p)) e.status = 'past'
    seen.add(p)
  }
  return { free, days: sorted }
}

const dayName = (d) => {
  const t = new Date().toISOString().slice(0, 10)
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  if (d === t) return 'Today'
  if (d === y) return 'Yesterday'
  return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export default function NotesTimeline({ notes }) {
  const { free, days } = useMemo(() => parse(notes), [notes])
  if (!free.length && !days.length) return <p className="text-sm text-slate-500">No notes yet.</p>
  let n = 0
  return (
    <div className="space-y-5">
      {free.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700 animate-fade-up dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300">
          {free.map((l, i) => <p key={i} className="whitespace-pre-wrap">{l}</p>)}
        </div>
      )}
      {days.map(([date, entries]) => (
        <div key={date}>
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">{dayName(date)}</p>
          <ol className="relative space-y-3 border-l-2 border-slate-100 pl-5 dark:border-slate-800">
            {entries.map((e) => {
              const [, icon, name, grad, tint] = e.portal || [null, ...OTHER]
              const [label, badge, pulse] = STATUS[e.status]
              return (
                <li key={e.key} className="relative animate-fade-up" style={{ animationDelay: `${Math.min(n++, 12) * 60}ms` }}>
                  <span className={`absolute -left-[31px] top-1 flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br ${grad} text-sm shadow-md ring-4 ring-white dark:ring-slate-900`}>{icon}</span>
                  <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-slate-700 dark:bg-slate-900">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-sm font-bold ${tint}`}>{name || e.head || 'Note'}</span>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge}`}>
                        {pulse && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" /></span>}
                        {label}
                      </span>
                      {e.times > 1 && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500 dark:bg-slate-800" title="The same line was written again">×{e.times}</span>}
                    </div>
                    <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{e.body}</p>
                    {e.toFill.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-semibold text-slate-500">Still to fill:</span>
                        {e.toFill.map(t => (
                          <span key={t.name} title={t.choices.length ? `Choices: ${t.choices.join(', ')}` : ''}
                            className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                            {t.name}{t.choices.length ? <span className="ml-1 text-amber-600/70">· {t.choices.length} choice{t.choices.length === 1 ? '' : 's'}</span> : null}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      ))}
    </div>
  )
}
