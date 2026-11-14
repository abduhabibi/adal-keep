/**
 * siteBrokers.js — the brokers another system knows (Pextran keeps only a
 * brokerId on each person; the broker's name and numbers come from its own
 * lists). Everything the site's pages load is looked through for brokers; after
 * the copy each one becomes an Adal Keep broker (or fills the one already there)
 * and each person gets her broker, when she has none yet.
 */

const ID = ['id', '_id', 'uid', 'brokerId', 'broker_id']
const NAME = ['name', 'fullName', 'full_name', 'brokerName', 'broker_name', 'displayName', 'firstName']
const PHONE = /phone|mobile|tel|contact|whats/i
const SKIP = /password|token|secret|hash|key$/i

const idOf = (o) => { for (const k of ID) if (o[k] != null && o[k] !== '') return String(o[k]); return null }
const nameOf = (o) => {
  for (const k of NAME) if (typeof o[k] === 'string' && o[k].trim()) {
    if (k === 'firstName') return [o.firstName, o.middleName, o.lastName].filter(Boolean).join(' ').trim()
    return o[k].trim()
  }
  return null
}

/** The broker id a person carries: brokerId, broker_id, or broker: {id}. */
export function brokerIdOf(raw = {}) {
  const v = raw.brokerId ?? raw.broker_id ?? raw.brokerID ?? (raw.broker && typeof raw.broker === 'object' ? idOf(raw.broker) : raw.broker)
  return v == null || v === '' ? null : String(v)
}

/** Looks through one answer of the site and keeps whatever could be a broker. */
export function collectBrokers(json, url, into, depth = 0) {
  if (!json || typeof json !== 'object' || depth > 6 || into.size > 20000) return into
  if (Array.isArray(json)) { for (const v of json) collectBrokers(v, url, into, depth + 1); return into }
  const id = idOf(json), name = nameOf(json)
  // A person has a passport; a broker does not.
  if (id && name && !Object.keys(json).some(k => /passport/i.test(k))) {
    const had = into.get(id)
    into.set(id, { ...(had || {}), ...json, __fromBrokerList: had?.__fromBrokerList || /broker|agent|partner|dalal/i.test(url || '') })
  }
  if (json.broker && typeof json.broker === 'object') collectBrokers(json.broker, 'broker', into, depth + 1)
  for (const v of Object.values(json)) if (v && typeof v === 'object') collectBrokers(v, url, into, depth + 1)
  return into
}

/** The Adal Keep broker for one of the site's brokers. */
export function brokerRow(b, siteName) {
  const phones = []
  for (const [k, v] of Object.entries(b)) {
    if (!PHONE.test(k) || SKIP.test(k)) continue
    for (const x of [v].flat()) if ((typeof x === 'string' || typeof x === 'number') && /\d{6,}/.test(String(x).replace(/\D/g, ''))) phones.push(String(x).trim())
  }
  const uniq = [...new Set(phones)]
  const extra = Object.entries(b)
    .filter(([k, v]) => !k.startsWith('__') && !SKIP.test(k) && !PHONE.test(k) && !ID.includes(k) && !NAME.includes(k) && v != null && v !== '' && typeof v !== 'object')
    .slice(0, 20).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
  return {
    name: nameOf(b),
    contact1: uniq[0] || b.email || null,
    contact2: uniq[1] || (uniq[0] && b.email) || null,
    address: [b.address, b.city, b.region, b.country].filter(x => typeof x === 'string' && x).join(', ') || null,
    notes: [`${siteName} broker ${idOf(b)}`, ...extra].join('\n').slice(0, 2000),
  }
}

const digits = (s) => String(s || '').replace(/\D/g, '').slice(-9)

/**
 * Makes the brokers and gives each person hers. people: [{ person, raw, profileId }].
 * Returns { created, filled, assigned }.
 */
export async function saveBrokers(db, people, found, siteName) {
  const out = { created: 0, filled: 0, assigned: 0 }
  if (!(await db.schema.hasTable('brokers'))) return out
  const cols = await db('brokers').columnInfo()
  const wanted = new Set(people.map(p => brokerIdOf(p.raw)).filter(Boolean))
  const mine = new Map()          // site id → Adal Keep broker id
  const all = await db('brokers').select('*')
  for (const [siteId, b] of found) {
    if (!wanted.has(siteId) && !b.__fromBrokerList) continue
    const row = brokerRow(b, siteName)
    if (!row.name) continue
    const tag = `${siteName} broker ${siteId}`
    const had = all.find(x => (x.notes || '').split('\n')[0] === tag)
      || all.find(x => (x.name || '').trim().toLowerCase() === row.name.toLowerCase())
      || (digits(row.contact1).length === 9 && all.find(x => [x.contact1, x.contact2].some(c => digits(c) === digits(row.contact1))))
    const now = new Date().toISOString()
    if (!had) {
      const ins = Object.fromEntries(Object.entries({ ...row, created_at: now, updated_at: now }).filter(([k]) => cols[k]))
      const [newId] = await db('brokers').insert(ins)
      all.push({ id: newId, ...ins })
      mine.set(siteId, newId)
      out.created++
    } else {
      // What was typed here stays.
      const empty = Object.fromEntries(Object.entries(row).filter(([k, v]) => cols[k] && v && (had[k] == null || had[k] === '')))
      if (Object.keys(empty).length) { await db('brokers').where('id', had.id).update({ ...empty, updated_at: now }); out.filled++ }
      mine.set(siteId, had.id)
    }
  }
  for (const p of people) {
    const b = mine.get(brokerIdOf(p.raw))
    if (!b || !p.profileId) continue
    const n = await db('profiles').where('id', p.profileId).where(q => q.whereNull('broker_id').orWhere('broker_id', 0)).update({ broker_id: b })
    out.assigned += n
  }
  Object.defineProperty(out, "mine", { value: mine })   // the site's broker id → Adal Keep broker (not part of the counts)
  return out
}
