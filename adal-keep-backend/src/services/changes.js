/**
 * changes.js — "something changed": every write to the database (a person on
 * a page, a robot, a move, a phone's change) is noticed here, and each open
 * window — on this PC and on the phones — is told which tables changed, so it
 * reloads what it shows at once instead of waiting for its next refresh.
 * At most one message every ~0.7 s, so a busy robot never floods anyone.
 */
import { EventEmitter } from 'events'

const bus = new EventEmitter()
bus.setMaxListeners(200)

// Bookkeeping tables that change all the time and show nowhere.
// Told under another name: only the page that shows it looks (not every list and timer).
const AS = { whatsapp_sends: 'whatsapp_log' }
const QUIET = new Set(['activity_log', 'cloud_sync', 'downloads_state', 'tutor_days', 'tutor_prefs', 'tutor_usage',
  'knowledge_base', 'license', 'updates', 'ingest_queue', 'ai_messages', 'ai_conversations', 'sqlite_sequence',
  'knex_migrations', 'knex_migrations_lock'])
// Written by itself at each look at a girl, and on no open page: the other PCs still get it
// (onChanged), the windows are not told. Told, every look made every window of every PC ask
// for everything again (~15 requests each, 2026-11-25).
const UNSEEN = new Set(['audit_log'])
const WRITE = /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|update(?:\s+or\s+\w+)?|delete\s+from|replace\s+into)\s+[`"[]?(\w+)/i
const GAP = 700

let pending = new Set(), timer = null, last = 0, version = 0

export function changed(table) {
  if (!table || QUIET.has(table)) return
  pending.add(AS[table] || table)
  if (timer) return
  timer = setTimeout(flush, Math.max(150, GAP - (Date.now() - last)))
}

function flush() {
  timer = null
  last = Date.now()
  const tables = [...pending]
  pending = new Set()
  if (!tables.length) return
  version++
  bus.emit('changed', { v: version, tables })
  const shown = tables.filter(t => !UNSEEN.has(t))
  if (!shown.length) return
  bus.emit('shown', { v: version, tables: shown })
  // The phones hear it over their live link.
  import('./liveChannel.js').then(m => m.broadcast({ t: 'changed', tables: shown })).catch(() => {})
}

/** Watches every query this database runs. */
export function watchChanges(db) {
  db.on('query-response', (_r, q) => {
    const m = WRITE.exec(q?.sql || '')
    // A profile being opened is not a change anyone else needs to reload for.
    if (m && !(m[1] === 'profiles' && /^\s*update\b[^]*\bset\s+[`"]?last_opened_at[`"]?\s*=\s*\?\s+where/i.test(q.sql))) changed(m[1])
  })
}

export function onChanged(fn) { bus.on('changed', fn); return () => bus.off('changed', fn) }
/** For the windows: only the tables a page can show. */
export function onShown(fn) { bus.on('shown', fn); return () => bus.off('shown', fn) }
export const changesVersion = () => version
