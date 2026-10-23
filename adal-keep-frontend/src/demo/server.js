/**
 * Demo server — answers the app's API inside the browser.
 *
 * services/api.js swaps axios' network adapter for `demoAdapter` in the demo
 * build, so every screen of the real app works unchanged on made-up data.
 * A visitor's changes are kept in their own browser (localStorage) and the
 * "Reset demo" button puts everything back.
 */
import { seed, FIELD_NAMES } from './data'
import { WORKFLOWS, MAX_RUNS, drive, finish, missingFor, onRunsChange } from './automation'
import { storeUpload } from './files'

const KEY = 'adal-demo-db'
let db = load()

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (saved && saved.version === seed().version) {
      // A run cannot keep "running" across a page reload: park it.
      for (const r of saved.runs) if (r.status === 'running') { r.status = 'paused'; r.pause_reason = 'Interrupted: the page was reloaded — press Continue' }
      return saved
    }
  } catch {}
  return seed()
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)) } catch {} }
export function resetDemo() { db = seed(); save() }
export const demoDb = () => db
export { onRunsChange }

const now = () => new Date().toISOString()
const nextId = () => ++db.nextId
const int = (v) => Number(v)

class HttpError extends Error { constructor(status, error) { super(error); this.status = status; this.body = { error } } }
const notFound = (what = 'Not found') => { throw new HttpError(404, what) }

function withBroker(p) {
  const b = db.brokers.find(x => x.id === p.broker_id)
  return { ...p, broker_name: b ? b.name : null }
}
function profile(id) { return db.profiles.find(p => p.id === int(id)) || notFound('Profile not found') }
function filesOf(fieldId) {
  return db.files.filter(f => f.field_id === int(fieldId)).map(({ id, original_name, path, mimetype, size }) => ({ id, original_name, path, mimetype, size }))
}
function fieldsOf(pid) {
  return db.fields.filter(f => f.profile_id === int(pid)).map(f => ({
    ...f, data_type: 'file', is_permanent: 1, value_text: null, created_at: now(), updated_at: now(), files: filesOf(f.id),
  }))
}
function ensureFields(pid) {
  if (db.fields.some(f => f.profile_id === pid)) return
  FIELD_NAMES.forEach((name, k) => db.fields.push({ id: nextId(), profile_id: pid, field_template_id: k + 1, name }))
}

// ---------------------------------------------------------------- runs
const runningRuns = () => db.runs.filter(r => r.status === 'running')
function snapshot() {
  return { max: MAX_RUNS, running: runningRuns().map(r => ({ runId: r.id, workflowId: r.workflow_id, profileId: r.profile_id, startedAt: r.started_at })) }
}
function publicRun(r) {
  const { view, ...rest } = r
  return { ...rest, context: JSON.stringify({ account_id: r.account_id }), log: JSON.stringify(r.log) }
}
function status(r) {
  const s = snapshot()
  return { state: r.status === 'running' ? 'running' : 'queued', ahead: 0, running: s.running.length, max: s.max }
}
function message(r, verb) {
  const s = status(r)
  return `Run #${r.id} ${verb} — working now in its own browser tab (${s.running} of ${s.max} running).`
}
function startRun(pid, wid, accountId) {
  const p = profile(pid)
  if (!WORKFLOWS.some(w => w.id === wid)) notFound('Workflow not found')
  const open = db.runs.find(r => r.profile_id === p.id && r.workflow_id === wid && ['running', 'paused', 'pending'].includes(r.status))
  if (open?.status === 'running') return { ok: true, runId: open.id, resumed: false, ...status(open), message: `Run #${open.id} is already working on this profile — not started a second time.` }
  if (open?.status === 'paused') { setTimeout(() => drive(db, open, save)); return { ok: true, runId: open.id, resumed: true, ...status(open), message: message(open, 'continued') } }
  const miss = missingFor(db, wid, p)
  if (miss.length) throw new HttpError(400, `Profile is missing: ${miss.join(', ')}`)
  if (runningRuns().length >= MAX_RUNS) throw new HttpError(409, `${MAX_RUNS} runs are already working — wait for one to finish (in the real system it waits in line).`)
  const r = {
    id: nextId(), profile_id: p.id, workflow_id: wid, account_id: accountId || 1,
    status: 'running', current_step: 0, log: [], pause_reason: null,
    started_at: now(), finished_at: null, created_at: now(), updated_at: now(), preferred_lane: null,
    view: null,
  }
  db.runs.push(r); save()
  setTimeout(() => drive(db, r, save))
  return { ok: true, runId: r.id, resumed: false, ...status(r), message: message(r, 'started') }
}

// ---------------------------------------------------------------- CV
function cvHtml(p) {
  let skills = {}
  try { skills = JSON.parse(p.skills || '{}') } catch {}
  const row = (k, v) => `<tr><th>${k}</th><td>${v ?? '—'}</td></tr>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:14px system-ui,sans-serif;margin:24px;color:#0f172a}
    .head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #0d9488;padding-bottom:10px}
    h1{margin:0;font-size:20px;color:#0f766e}.ar{font-size:18px}
    .grid{display:grid;grid-template-columns:1fr 170px;gap:16px;margin-top:14px}
    table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left}th{background:#f0fdfa;width:42%}
    .pics img{width:160px;border:1px solid #cbd5e1;border-radius:6px;display:block;margin-bottom:8px;background:#f8fafc}
    .demo{margin-top:14px;font-size:11px;color:#92400e;background:#fef3c7;padding:6px 8px;border-radius:6px}
  </style></head><body>
  <div class="head"><h1>Demo Agency PLC</h1><span class="ar">وكالة تجريبية</span></div>
  <div class="grid"><table>
    ${row('Full name', p.full_name)}${row('Passport no.', p.passport_number)}${row('Labor ID', p.labor_id)}
    ${row('Date of birth', p.date_of_birth)}${row('Place of birth', p.place_of_birth)}${row('Religion', p.religion)}
    ${row('Marital status', p.marital_status)}${row('Children', p.children_count)}${row('Height / weight', `${p.height} cm / ${p.weight} kg`)}
    ${row('Education', p.education_level)}${row('Experience', p.work_experience === 'Have experience' ? `${p.experience_country}, ${p.experience_years} years` : 'No experience')}
    ${row('Skills', Object.keys(skills).filter(k => skills[k]).join(', ').replace(/_/g, ' '))}
    ${row('Salary', '1000 SAR / month · 2 years')}
  </table><div class="pics">
    <img src="${location.origin}/api/files/${p.id * 100 + 21}/download" alt="">
    <img src="${location.origin}/api/files/${p.id * 100 + 22}/download" alt="">
  </div></div>
  <div class="demo">Demo CV — made-up person.</div></body></html>`
}

// ---------------------------------------------------------------- routes
const routes = []
const on = (method, pattern, fn) => {
  const keys = []
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)' }) + '/?$')
  routes.push({ method, re, keys, fn })
}

on('get', '/setup/status', () => ({ state: 'ready', companyName: 'Demo Agency', subscription: subscription() }))
on('get', '/subscription/status', () => subscription())
on('post', '/subscription/unlock', () => ({ ok: true }))
on('get', '/auth/me', () => ({ id: 1, name: 'Demo Admin', username: 'admin', role: 'admin' }))
on('post', '/auth/logout', () => ({ ok: true }))
on('get', '/settings', () => ({ agency_email: 'demo@example.com', active_employee_id: '1', active_employee_name: 'Demo Admin' }))
on('put', '/settings', () => ({ ok: true }))
on('post', '/settings/wallpaper', () => ({ ok: true }))
on('delete', '/settings/wallpaper', () => ({ ok: true }))
on('get', '/system/update/check', () => ({ hasUpdate: false, upToDate: true, installed: { short: 'demo' }, latest: { short: 'demo', message: 'Demo' }, repo: 'demo', branch: 'main' }))
on('post', '/system/update/apply', () => ({ success: true, message: 'This is the demo — nothing to install.' }))

on('get', '/dashboard', () => {
  const c = (s) => db.profiles.filter(p => p.status === s).length
  return {
    totalProfiles: db.profiles.length, totalBrokers: db.brokers.length,
    statusCounts: { pending: c('pending'), in_progress: c('in_progress'), completed: c('completed'), active: c('active') },
    recent: [...db.profiles].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6)
      .map(p => ({ id: p.id, full_name: p.full_name, phone_number: p.phone_number, status: p.status, created_at: p.created_at, broker_name: withBroker(p).broker_name })),
  }
})

on('get', '/profiles', (_, q) => db.profiles.filter(p => !q.broker_id || p.broker_id === int(q.broker_id)).map(withBroker))
on('get', '/profiles/:id', ({ id }) => withBroker(profile(id)))
on('post', '/profiles', (_, __, body) => {
  const p = { ...seed().profiles[0], ...body, id: nextId(), labor_id: body.labor_id || null, created_at: now(), updated_at: now(), status: body.status || 'pending' }
  p.full_name = body.full_name || [body.first_name, body.middle_name, body.last_name].filter(Boolean).join(' ') || 'NEW PROFILE'
  db.profiles.push(p); ensureFields(p.id); save()
  return withBroker(p)
})
const update = ({ id }, _, body) => { const p = profile(id); Object.assign(p, body, { id: p.id, updated_at: now() }); save(); return withBroker(p) }
on('put', '/profiles/:id', update)
on('patch', '/profiles/:id', update)
on('delete', '/profiles/:id', ({ id }) => { db.profiles = db.profiles.filter(p => p.id !== int(id)); save(); return { ok: true } })
on('get', '/profiles/:id/fields', ({ id }) => { profile(id); ensureFields(int(id)); return fieldsOf(id) })
on('get', '/profiles/:id/fields/:fid/files', ({ fid }) => filesOf(fid))
const upload = async ({ id, fid }, _, body) => {
  const field = db.fields.find(f => f.id === int(fid)) || notFound('Field not found')
  const blobs = body instanceof FormData ? body.getAll('file').concat(body.getAll('files')).filter(v => v instanceof Blob) : []
  for (const b of blobs) {
    const f = { id: nextId(), profile_id: int(id), field_id: field.id, field: field.name, kind: 'upload', original_name: b.name || 'upload', path: `demo/${b.name}`, mimetype: b.type || 'application/octet-stream', size: b.size }
    await storeUpload(f.id, b)
    db.files.push(f)
  }
  save()
  return { ok: true, files: filesOf(field.id) }
}
on('post', '/profiles/:id/fields/:fid/upload', upload)
on('post', '/profiles/:id/fields/:fid/files', upload)
on('delete', '/files/:id', ({ id }) => { db.files = db.files.filter(f => f.id !== int(id)); save(); return { ok: true } })

on('get', '/brokers', () => db.brokers.map(b => ({ ...b, profile_count: db.profiles.filter(p => p.broker_id === b.id).length })))
on('get', '/brokers/:id', ({ id }) => db.brokers.find(b => b.id === int(id)) || notFound('Broker not found'))
on('post', '/brokers', (_, __, body) => { const b = { ...body, id: nextId(), created_at: now(), updated_at: now() }; db.brokers.push(b); save(); return b })
on('put', '/brokers/:id', ({ id }, _, body) => { const b = db.brokers.find(x => x.id === int(id)) || notFound(); Object.assign(b, body, { id: b.id }); save(); return b })
on('delete', '/brokers/:id', ({ id }) => { db.brokers = db.brokers.filter(b => b.id !== int(id)); save(); return { ok: true } })
const assign = (bid) => (_, __, body) => {
  const ids = (body.profile_ids || body.profileIds || [body.profile_id]).map(int)
  db.profiles.forEach(p => { if (ids.includes(p.id)) p.broker_id = bid === 'set' ? int(body.broker_id) : null }); save(); return { ok: true }
}
on('post', '/brokers/assign', assign('set'))
on('post', '/brokers/unassign', assign(null))

on('get', '/notifications', () => db.notifications)
on('delete', '/notifications/all', () => { db.notifications = []; save(); return { ok: true } })
on('delete', '/notifications/:id', ({ id }) => { db.notifications = db.notifications.filter(n => n.id !== int(id)); save(); return { ok: true } })
on('get', '/tasks', () => db.tasks)
on('patch', '/tasks/:id', ({ id }, _, body) => { const t = db.tasks.find(x => x.id === int(id)) || notFound(); Object.assign(t, body); save(); return t })
on('delete', '/tasks/:id', ({ id }) => { db.tasks = db.tasks.filter(t => t.id !== int(id)); save(); return { ok: true } })
on('post', '/ai-tasks/:id/approve', ({ id }) => { const t = db.tasks.find(x => x.id === int(id)); if (t) t.status = 'approved'; save(); return { ok: true } })
on('post', '/ai-tasks/:id/reject', ({ id }) => { const t = db.tasks.find(x => x.id === int(id)); if (t) t.status = 'declined'; save(); return { ok: true } })

on('get', '/employees', () => db.employees)
on('post', '/employees', (_, __, body) => { const e = { ...body, id: nextId(), created_at: now(), device_serial: null }; delete e.password; db.employees.push(e); save(); return e })
on('put', '/employees/:id', ({ id }, _, body) => { const e = db.employees.find(x => x.id === int(id)) || notFound(); Object.assign(e, body, { id: e.id }); delete e.password; save(); return e })
on('delete', '/employees/:id', ({ id }) => { db.employees = db.employees.filter(e => e.id !== int(id)); save(); return { ok: true } })
on('post', '/employees/device-login', () => ({ ok: true, employee: db.employees[0] }))
on('post', '/employees/device-logout', () => ({ ok: true }))
on('post', '/employees/device-resume', () => ({ ok: true, employee: db.employees[0] }))

for (const [path, key] of [['/lmis/accounts', 'lmisAccounts'], ['/musaned/accounts', 'musanedAccounts'], ['/quick-links', 'quickLinks']]) {
  on('get', path, () => db[key])
  on('post', path, (_, __, body) => { const a = { ...body, id: nextId(), created_at: now(), updated_at: now() }; db[key].push(a); save(); return a })
  const upd = ({ id }, _, body) => { const a = db[key].find(x => x.id === int(id)) || notFound(); Object.assign(a, body, { id: a.id }); save(); return a }
  on('patch', path + '/:id', upd)
  on('put', path + '/:id', upd)
  on('delete', path + '/:id', ({ id }) => { db[key] = db[key].filter(x => x.id !== int(id)); save(); return { ok: true } })
}

on('get', '/checklists', () => db.checklists)
on('post', '/checklists', (_, __, body) => { const c = { ...body, id: nextId(), profiles: [], created_at: now() }; db.checklists.push(c); save(); return c })
on('delete', '/checklists/:id', ({ id }) => { db.checklists = db.checklists.filter(c => c.id !== int(id)); save(); return { ok: true } })
on('post', '/checklists/:id/profiles', () => ({ ok: true }))
on('delete', '/checklists/:id/profiles/:pid', () => ({ ok: true }))

on('get', '/cv/templates', () => db.cvTemplates)
on('get', '/cv/templates/:id', ({ id }) => db.cvTemplates.find(t => t.id === int(id)) || notFound())
on('get', '/cv/generated', () => db.generated)
on('get', '/cv/profile-readiness/:id', ({ id }) => {
  const p = profile(id)
  const has = (n) => db.files.some(f => f.profile_id === p.id && f.field === n)
  let skills = {}
  try { skills = JSON.parse(p.skills || '{}') } catch {}
  const blockers = []
  if (!p.broker_id) blockers.push('Broker not assigned')
  if (!has('Photo')) blockers.push('Photo missing')
  if (!has('Full Body Photo')) blockers.push('Full body photo missing')
  if (!p.labor_id) blockers.push('Labor ID missing')
  if (!Object.values(skills).some(Boolean)) blockers.push('No skills selected')
  if (!p.religion) blockers.push('Religion missing')
  if (!p.marital_status) blockers.push('Marital status missing')
  return {
    profile: p, missing: [], has_photo: has('Photo'), has_full_body_photo: has('Full Body Photo'), field_file_counts: {},
    missing_photos: [!has('Photo') && 'Photo', !has('Full Body Photo') && 'Full Body Photo'].filter(Boolean),
    cv_blockers: blockers, can_generate: blockers.length === 0,
  }
})
on('post', '/cv/preview', (_, __, body) => cvHtml(profile(body.profile_id)))
on('post', '/cv/templates/preview-html', (_, __, body) => cvHtml(db.profiles[0]))
const generate = (_, __, body) => {
  const p = profile(body.profile_id)
  const url = URL.createObjectURL(new Blob([cvHtml(p)], { type: 'text/html' }))
  const g = { id: nextId(), profile_id: p.id, template_id: int(body.template_id) || 1, filename: `AdalCV_${p.full_name.replace(/\s+/g, '_')}.html`, data_snapshot: '{}', pdf_path: url, created_by: 'demo', created_at: now(), updated_at: now(), profile_name: p.full_name, passport_number: p.passport_number, template_name: 'Standard CV', agency_name: 'Demo Agency PLC' }
  db.generated.unshift(g); save()
  return { ok: true, generated_cv_id: g.id, file_id: g.id, filename: g.filename, download_url: url }
}
on('post', '/cv/generate', generate)
on('post', '/cv/generated/:id/reformat', ({ id }, _, body) => generate(null, null, { ...body, profile_id: (db.generated.find(g => g.id === int(id)) || {}).profile_id }))
on('delete', '/cv/generated/:id', ({ id }) => { db.generated = db.generated.filter(g => g.id !== int(id)); save(); return { ok: true } })
for (const m of ['post', 'patch', 'put', 'delete']) {
  on(m, '/cv/templates', () => { throw new HttpError(403, 'Editing CV templates is turned off in the demo.') })
  on(m, '/cv/templates/:id', () => { throw new HttpError(403, 'Editing CV templates is turned off in the demo.') })
  on(m, '/cv/templates/:id/:x', () => { throw new HttpError(403, 'Editing CV templates is turned off in the demo.') })
}

on('get', '/profiles/:id/automations', ({ id }) => {
  const pid = int(id)
  return {
    workflows: WORKFLOWS.map(w => {
      const latest = [...db.runs].reverse().find(r => r.profile_id === pid && r.workflow_id === w.id)
      return { ...w, latest: latest ? publicRun(latest) : null }
    }),
    queue: snapshot(),
  }
})
on('post', '/profiles/:id/automations/:wid/start', ({ id, wid }, _, body) => startRun(id, wid, body?.account_id))
on('get', '/automations/:id', ({ id }) => {
  const r = db.runs.find(x => x.id === int(id)) || notFound('Run not found')
  return { ...publicRun(r), log: r.log, queue: null }
})
on('post', '/automations/:id/:action', ({ id, action }) => {
  const r = db.runs.find(x => x.id === int(id)) || notFound('Run not found')
  if (action === 'resume') {
    if (r.status !== 'paused') return { ok: true, message: `Run #${r.id} is ${r.status}.` }
    if (r.pause_reason === 'awaiting-human-submit') r.current_step = 1   // "Retry uploads"
    setTimeout(() => drive(db, r, save))
    return { ok: true, ...status(r), message: message(r, 'continued') }
  }
  if (action === 'complete') { finish(r); save(); return { ok: true, message: `Run #${r.id} marked complete.` } }
  if (action === 'cancel') { r.status = 'cancelled'; r.updated_at = now(); save(); return { ok: true, tabClosed: false, message: `Run #${r.id} cancelled — its tab stays open.` } }
  if (action === 'pause') throw new HttpError(409, 'A working run cannot be paused — cancel it or let it finish.')
  notFound()
})

function subscription() {
  return { mode: 'active', daysLeft: 365, trialDays: 30, trialEndsAt: Date.now() + 365 * 86400000, pcNumber: 'DEMO', sellerPhone: '', clockBack: false, unlockedAt: null, serverTime: Date.now() }
}

// ---------------------------------------------------------------- adapter
/** axios adapter: answers from the routes above, with a little network delay. */
export async function demoAdapter(config) {
  const method = (config.method || 'get').toLowerCase()
  const u = new URL(String(config.url || ''), 'http://demo/api/')
  const path = (u.pathname.startsWith('/api') ? u.pathname.slice(4) : u.pathname) || '/'
  const query = { ...Object.fromEntries(u.searchParams), ...(config.params || {}) }
  let body = config.data
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch {} }
  await new Promise(r => setTimeout(r, 80 + Math.random() * 120))

  const reply = (status, data) => ({ data, status, statusText: String(status), headers: {}, config, request: {} })
  for (const r of routes) {
    if (r.method !== method) continue
    const m = path.match(r.re)
    if (!m) continue
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
    try {
      return reply(200, await r.fn(params, query, body || {}))
    } catch (e) {
      const status = e.status || 500
      const err = new Error(e.message)
      err.config = config
      err.response = reply(status, e.body || { error: e.message })
      err.isAxiosError = true
      throw err
    }
  }
  const err = new Error(`Demo: ${method.toUpperCase()} ${path} is not available in the demo`)
  err.config = config
  err.response = reply(404, { error: 'Not available in the demo' })
  err.isAxiosError = true
  throw err
}
