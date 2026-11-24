/**
 * featureUse.js — how much an agency uses each Adal Keep feature (asked on
 * 2026-11-14), for the Usage graphs in Adal Keep Admin.
 *
 *  - Work kept in its own table is counted from that table, so the history
 *    from before this existed shows too (profiles, documents, CVs, every
 *    robot, WhatsApp CVs, passport reads, brokers, AI, tasks, the Trash).
 *  - Everything else is counted as it is done (the middleware below): a
 *    profile opened or edited, a CV downloaded, Refine, a move from Pextran,
 *    a chat message … one row per day and feature in feature_use.
 *
 * Only counts go to the cloud (keep_meta "/_usage", cloudSync.js) — no names,
 * no profiles, nothing typed.
 */

// [group, feature, method regex, path regex (after /api)]
const RULES = [
  ['Profiles', 'Profile opened', /POST/, /^\/profiles\/\d+\/opened$/],
  ['Profiles', 'Profile edited', /PUT|PATCH/, /^\/profiles\/\d+$/],
  ['Profiles', 'New profile from a passport scan', /POST/, /^\/new-profile\/(read|attach)$/],
  ['Profiles', 'Step marked done', /POST/, /^\/profiles\/\d+\/automations\/[^/]+\/mark-done$/],
  ['Profiles', 'Checklists', /POST|PUT|DELETE/, /^\/checklists\b/],
  ['Profiles', 'Notes', /POST|PUT|DELETE/, /^\/notes\b/],
  ['Profiles', 'Restored from the Trash', /POST/, /^\/trash\/\d+\/restore$/],
  ['Documents', 'Document opened or downloaded', /GET/, /^\/files\/\d+\/download$/],
  ['Documents', 'Photo Refine', /POST/, /^\/files\/\d+\/refine$/],
  ['Documents', 'Document tray', /POST/, /^\/(files\/tray|profiles\/\d+\/fields\/\d+\/assign-tray-file)$/],
  ['Documents', 'Embassy print', /GET/, /^\/embassy\/print\b/],
  ['Documents', 'Contracts check', /POST/, /^\/contracts\/(check|scan)$/],
  ['CV', 'CV downloaded', /GET/, /^\/cv\/generated\/\d+\/download$/],
  ['CV', 'CV re-made with another template', /POST/, /^\/cv\/generated\/\d+\/reformat$/],
  ['CV', 'CV templates', /POST|PUT|PATCH|DELETE/, /^\/cv\/(templates|headers)\b/],
  ['Robots', 'Robot needed a person (captcha, code, Save)', /POST/, /^\/automations\/\d+\/(captcha|input|complete|attention\/done)$/],
  ['Robots', 'Robot paused, resumed or cancelled', /POST/, /^\/automations\/\d+\/(pause|resume|cancel)$/],
  ['Robots', 'Site accounts', /POST|PUT|PATCH|DELETE/, /^\/(lmis|musaned|visa|tasheer|insurance)\/accounts\b/],
  ['WhatsApp', 'WhatsApp to many', /POST/, /^\/whatsapp\/(bulk|notify)$/],
  ['WhatsApp', 'WhatsApp agents', /POST|PATCH|DELETE/, /^\/whatsapp\/agents\b/],
  ['WhatsApp', 'WhatsApp connected', /POST/, /^\/whatsapp\/connect$/],
  ['Team', 'Signed in', /POST/, /^\/(auth\/)?login$/],
  ['Team', 'Employees', /POST|PUT|PATCH|DELETE/, /^\/employees\b/],
  ['Team', 'Tasks handled', /POST|PUT|PATCH/, /^\/tasks\/\d+/],
  ['Team', 'Brokers assigned', /POST/, /^\/brokers\/(assign|unassign)$/],
  ['Team', 'Branches', /POST|PUT|DELETE/, /^\/(branches\b|branch\/merge$)/],
  ['Chat', 'Chat messages sent', /POST/, /^\/chat\/send$/],
  ['Chat', 'Chat groups', /POST/, /^\/chat\/(groups|direct)\b/],
  ['Chat', 'Tutor questions', /POST/, /^\/tutor\/ask$/],
  ['Moves', 'Move from another system (Pextran …)', /POST/, /^\/transitions\/[^/]+\/start$/],
  ['Moves', 'Musaned import', /POST/, /^\/musaned\/import\b/],
  ['Phone & PCs', 'Phone app paired', /POST/, /^\/mobile\/(pair|join-requests\/[^/]+)$/],
  ['Phone & PCs', 'Another PC opened Adal Keep', /POST/, /^\/pc-access\/answer$/],
  ['Phone & PCs', 'Backups', /POST/, /^\/backup\/(run|restore)$/],
  ['Settings', 'Settings changed', /POST|PUT|DELETE/, /^\/settings\b/],
  ['Settings', 'Quick links', /POST|PUT|DELETE/, /^\/quick-links\b/],
]

// Robots (automation_queue.workflow_id): their names on the Usage graph.
const ROBOTS = {
  musaned_add_candidate: 'Musaned: add candidate', musaned_check_chosen: 'Musaned: check chosen', musaned_cv_import: 'Musaned: CV import',
  musaned_delete: 'Musaned: delete', musaned_login: 'Musaned: sign in', contract_import_labour: 'Musaned: contract to labour',
  delete_labour: 'LMIS: delete labour', lmis: 'LMIS', lmis_contract: 'LMIS contract', insurance_certificate: 'Insurance certificate',
  mofa_visa: 'Visa (Enjaz)', mofa_find_app: 'Visa: find application', mofa_pay: 'Visa: pay', police_certificate: 'Police certificate',
  tasheer_schedule: 'Tasheer appointment', wafid_book: 'Wafid booking', wafid_check: 'Wafid result check', wafid_slip: 'Wafid slip',
}
const robotName = (id) => ROBOTS[id] || String(id || 'robot').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())

// Counted from their own tables: [group, feature, table, date column, extra where]
const TABLES = [
  ['Profiles', 'Profile added', 'profiles', 'created_at'],
  ['Profiles', 'Moved to the Trash', 'trash', 'deleted_at'],
  ['Documents', 'Document uploaded', 'files', 'created_at'],
  ['Documents', 'Passport read', 'document_verifications', 'created_at'],
  ['CV', 'CV made', 'generated_cvs', 'created_at'],
  ['WhatsApp', 'CV sent to an agent on WhatsApp', 'whatsapp_sends', 'sent_at'],
  ['Team', 'Broker added', 'brokers', 'created_at'],
  ['Team', 'Task given', 'tasks', 'created_at'],
  ['Chat', 'AI assistant messages', 'ai_messages', 'created_at'],
]

/** Every feature there is (the admin shows the ones never used too). */
export function catalog() {
  const out = []
  for (const [g, f] of TABLES) out.push({ g, f })
  for (const id of Object.keys(ROBOTS)) out.push({ g: 'Robots', f: robotName(id) })
  for (const [g, f] of RULES) out.push({ g, f })
  return out
}

const localDay = (d = new Date()) => d.toLocaleDateString('en-CA')

// --------------------------------------------------------------- counting --
const pending = new Map()   // "day\tfeature" → count
let dbRef = null

export function featureOf(method, path) {
  for (const [, f, m, p] of RULES) if (m.test(method) && p.test(path)) return f
  return null
}

export function featureUseMiddleware(req, res, next) {
  if (!req.originalUrl.startsWith('/api/')) return next()
  res.on('finish', () => {
    if (res.statusCode >= 400) return
    const f = featureOf(req.method, req.originalUrl.slice(4).split('?')[0])
    if (!f) return
    const k = `${localDay()}\t${f}`
    pending.set(k, (pending.get(k) || 0) + 1)
  })
  next()
}

export async function flushFeatureUse(db = dbRef) {
  if (!db || !pending.size) return
  const rows = [...pending]; pending.clear()
  for (const [k, n] of rows) {
    const [day, feature] = k.split('\t')
    try {
      await db.raw('insert into feature_use (day, feature, count) values (?, ?, ?) on conflict(day, feature) do update set count = count + excluded.count', [day, feature, n])
    } catch { pending.set(k, (pending.get(k) || 0) + n) }   // table not there yet: next time
  }
}

export function startFeatureUse(db) {
  dbRef = db
  setInterval(() => flushFeatureUse(db).catch(() => {}), 60000).unref()
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { flushFeatureUse(db).catch(() => {}) })
}

// ---------------------------------------------------------------- report --
const DAYS = 90

/**
 * { at, days: 90, first_day, features: [{ g, f, total, d: { 'YYYY-MM-DD': n } }], catalog }
 * `total` is all time; `d` only the last 90 days.
 */
export async function usageReport(db) {
  await flushFeatureUse(db).catch(() => {})
  const since = localDay(new Date(Date.now() - (DAYS - 1) * 86400000))
  const out = new Map()
  const add = (g, f, day, n) => {
    const r = out.get(f) || { g, f, total: 0, d: {} }
    r.total += n
    if (day && day >= since) r.d[day] = (r.d[day] || 0) + n
    out.set(f, r)
  }
  // SQLite keeps dates as ISO text or as milliseconds: the local day of either.
  const dayOf = (col) => `case when typeof(${col}) in ('integer','real') then date(${col} / 1000, 'unixepoch', 'localtime') else date(${col}, 'localtime') end`
  for (const [g, f, table, col] of TABLES) {
    try {
      const rows = await db.raw(`select ${dayOf(col)} as day, count(*) as n from "${table}" where ${col} is not null group by day`)
      for (const r of rows) add(g, f, r.day, Number(r.n))
    } catch {}
  }
  try {
    const rows = await db.raw(`select workflow_id as w, ${dayOf('created_at')} as day, count(*) as n from automation_queue group by w, day`)
    for (const r of rows) add('Robots', robotName(r.w), r.day, Number(r.n))
  } catch {}
  try {
    const group = new Map(RULES.map(([g, f]) => [f, g]))
    for (const r of await db('feature_use').select('day', 'feature', 'count')) add(group.get(r.feature) || 'Other', r.feature, r.day, Number(r.count))
  } catch {}
  return { at: new Date().toISOString(), days: DAYS, first_day: since, features: [...out.values()].sort((a, b) => b.total - a.total), catalog: catalog() }
}
