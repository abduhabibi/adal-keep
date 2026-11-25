/**
 * Adal Keep Admin — Lock / Unlock, and what is known of each registered Adal Keep.
 *
 * Lock: the only thing that locks an agency (adal-keep-backend services/plans.js):
 * its signed licence says `suspended`. Its main PC's number is signed, and the
 * numbers of its other PCs Admin knows (a PC that holds the main role meanwhile
 * reads its own). Who locked or unlocked, when and why: agency-locks.json.
 *
 * Everything shown comes from what Admin receives already (agencies, sign-ups,
 * the PCs' beats, the online copy's summary, phones, the ledger). Seller notes,
 * the lock history and the registrations already seen are kept on Adal's PC only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isPc = (n) => /^\d{6}$/.test(String(n || ''))
/** Asked for by Adal, and not sent by any PC today: said so, never made up. */
export const NOT_COLLECTED = ['Windows user name (the beat carries the employee signed in, not the Windows account)', 'Who installed it and from which place', 'When each Companion and each PC was first registered (only the agency\'s account has a date)']

export function registryApi({ dir, rest, readLicense, saveLicense, mainAgencies, branchRe, api, tell }) {
  const file = (n) => path.join(dir, n)
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')) } catch { return d } }
  const write = (n, o) => { const p = file(n); fs.writeFileSync(p + '.new', JSON.stringify(o, null, 1)); fs.renameSync(p + '.new', p) }
  const LOCKS = 'agency-locks.json', NOTES = 'seller-notes.json', SEEN = 'registrations-seen.json'
  const me = () => { try { return `${os.userInfo().username}@${os.hostname()}` } catch { return os.hostname() } }

  const find = async (q) => {
    const a = (await mainAgencies()).find(x => (q.pc && x.pc_number === String(q.pc)) || (q.id && (x.id === q.id || x.ids.includes(q.id))))
    if (!a) throw new Error('No such agency')
    return a
  }
  /** The agency's PCs from their beats, and its branch accounts. */
  async function pcsOf(a) {
    const f = await (api['GET /api/fleet']?.() ?? Promise.resolve(null)).catch(() => null)
    return (f?.agencies || []).flatMap(g => g.pcs).filter(p => a.ids.includes(p.agency_id) || a.ids.includes(p.id))
  }
  async function branchesOf(a) {
    const rows = await rest('GET', 'agencies?is_admin=eq.false&select=id,name,pc_number,created_at,last_seen').catch(() => [])
    return (rows || []).filter(r => branchRe.test(r.name || '') && String(r.name).replace(branchRe, '') === a.name)
      .map(r => ({ id: r.id, number: String(r.name).match(/(\d{6})$/)?.[1] || r.pc_number || null, created_at: r.created_at, last_seen: r.last_seen }))
  }
  /** Every PC number of the agency: its main PC first. Never a number that is another agency's main PC. */
  async function numbersOf(a) {
    const [pcs, branches, mains] = await Promise.all([pcsOf(a), branchesOf(a), mainAgencies()])
    const others = new Set(mains.filter(m => m.id !== a.id).map(m => m.pc_number))
    return [...new Set([a.pc_number, ...pcs.map(p => p.pc_number), ...branches.map(b => b.number)].map(n => String(n || '')))].filter(n => isPc(n) && (n === a.pc_number || !others.has(n)))
  }

  async function setLock({ pc, locked, note = '', quiet = false }) {
    const a = await find({ pc })
    if (!isPc(a.pc_number)) throw new Error('This agency has no PC number yet: it cannot be locked.')
    const at = new Date().toISOString()
    const done = [], failed = []
    // The main PC's number first: its licence is what its other PCs follow.
    for (const n of await numbersOf(a)) {
      try {
        const had = await readLicense(n)
        if (!locked && n !== a.pc_number && !had?.suspended) continue
        const l = { ...(had || {}) }
        if (locked) l.suspended = { at: l.suspended?.at || at, note: String(note || '').slice(0, 300) }
        else delete l.suspended
        await saveLicense(n, l)
        done.push(n)
      } catch (e) {
        if (n === a.pc_number) throw e
        failed.push({ pc: n, why: e.message })
      }
    }
    const all = read(LOCKS, {})
    const entry = { at, action: locked ? 'lock' : 'unlock', by: me(), note: String(note || '').slice(0, 300), pcs: done, ...(failed.length ? { failed } : {}) }
    ;(all[a.pc_number] ||= []).push(entry)
    write(LOCKS, all)
    if (!locked && !quiet) await tell(a.id, 'Adal Keep: your Adal Keep is open again.').catch(() => {})
    return { ok: true, locked: !!locked, pcs: done, failed, entry }
  }

  /** Everything known of one registered agency. */
  async function details(q) {
    const a = await find(q)
    const ids = a.ids.join(',')
    const [pcs, branches, signups, meta, phones, accounts, receipts, bill, lic] = await Promise.all([
      pcsOf(a), branchesOf(a),
      rest('GET', `agency_signups?agency_id=in.(${ids})&select=*`).catch(() => null),
      rest('GET', `keep_meta?agency_id=eq.${a.id}&key=in.(/_summary,/_pc)&select=key,data,updated_at`).catch(() => []),
      rest('GET', `keep_devices?agency_id=in.(${ids})&select=user_id,name,created_at,last_seen,revoked&order=created_at.desc`).catch(() => []),
      rest('GET', `agencies?id=in.(${ids})&select=id,created_at,last_seen&order=created_at.asc`).catch(() => []),
      rest('GET', `unlock_requests?agency_id=in.(${ids})&select=id,status,note,created_at,decided_at&order=id.desc&limit=20`).catch(() => []),
      (api['GET /api/billing']?.() ?? Promise.resolve(null)).catch(() => null),
      isPc(a.pc_number) ? readLicense(a.pc_number).catch(e => ({ error: e.message })) : null,
    ])
    const s = meta?.find(m => m.key === '/_summary')?.data || null
    const beat = meta?.find(m => m.key === '/_pc')?.data || null
    const b = (bill?.agencies || []).find(x => x.pc_number === a.pc_number) || null
    const sign = (signups || []).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))[0] || null
    const roleOf = (p) => (p.role === 'main' ? 'main' : p.role || 'PC')
    const companionsNow = pcs.filter(p => p.role !== 'main').length
    return {
      id: a.id, name: a.name, pc_number: a.pc_number,
      registered_at: a.first_seen || a.created_at, accounts: (accounts || []).map(x => ({ created_at: x.created_at, last_seen: x.last_seen })),
      signup: sign && { name: sign.name, phone: sign.phone, email: sign.email, at: sign.created_at, status: sign.status, note: sign.note || null },
      signup_known: !!signups, ceo: s?.ceo || null, last_seen: beat?.at || a.last_seen || null,
      pcs: pcs.map(p => ({ id: p.id, name: p.name, number: p.pc_number, role: roleOf(p), version: p.beat?.version || null, os: p.beat?.os || null, employee: p.beat?.employee || null, last_seen: p.beat?.at || null, light: p.light })),
      branches, mains: pcs.length - companionsNow, companions: companionsNow,
      // (A Companion that sends beats has an account here too: it is among the PCs.)
      phones: (phones || []).filter(p => !pcs.some(x => x.id === p.user_id)).map(p => ({ name: p.name, since: p.created_at, last_seen: p.last_seen || null, revoked: !!p.revoked })),
      girls: s?.profiles ?? null, employees: s?.has?.employees ?? null, version: s?.version || null,
      plan: lic?.plan || 'premium', paid_until: lic?.paid_until || null, trial_until: lic?.trial_until || null,
      locked: lic?.suspended || null, licence_error: lic?.error || null, licence_at: lic?.at || null,
      pc_licence_at: beat?.lic_at || null, pc_locked: beat?.suspended ?? null,
      renewal: b?.renewal || null, payments: read('billing-ledger.json', []).filter(p => p.pc === a.pc_number).reverse(), receipts: receipts || [],
      notes: read(NOTES, {})[a.pc_number || a.id] || '',
      locks: [...(read(LOCKS, {})[a.pc_number] || [])].reverse(),
      not_collected: NOT_COLLECTED,
    }
  }

  /** Registrations not seen yet. The first look ever takes all that exist as seen. */
  async function fresh() {
    const rows = await rest('GET', 'agencies?is_admin=eq.false&select=id,name,pc_number,created_at&order=created_at.desc')
    const seen = read(SEEN, null)
    if (!seen) { write(SEEN, { ids: rows.map(r => r.id) }); return [] }
    const had = new Set(seen.ids), mains = await mainAgencies()
    const list = rows.filter(r => !had.has(r.id))
    const sign = list.length ? await rest('GET', `agency_signups?agency_id=in.(${list.map(r => r.id).join(',')})&select=agency_id,phone,email`).catch(() => []) : []
    return list.map(r => {
      const m = mains.find(x => x.ids.includes(r.id)), g = (sign || []).find(x => x.agency_id === r.id)
      return { id: r.id, name: r.name, pc_number: r.pc_number, at: r.created_at, kind: branchRe.test(r.name || '') ? 'branch PC' : m && m.ids.length > 1 ? 'the same PC, installed again' : 'new agency', phone: g?.phone || null, email: g?.email || null }
    })
  }

  return {
    setLock,
    routes: {
      'POST /api/lock': async (q, b) => { if (typeof b.locked !== 'boolean') throw new Error('Lock or unlock?'); return setLock({ pc: String(b.pc || ''), locked: b.locked, note: b.note }) },
      'GET /api/agency/details': details,
      'POST /api/agency/notes': async (q, b) => { const a = await find(b); const all = read(NOTES, {}); all[a.pc_number || a.id] = String(b.notes || '').slice(0, 5000); write(NOTES, all); return { ok: true } },
      'GET /api/registrations': async () => ({ fresh: await fresh() }),
      'POST /api/registrations/seen': async (q, b) => { const seen = read(SEEN, { ids: [] }); const ids = (Array.isArray(b.ids) ? b.ids : []).map(String); write(SEEN, { ids: [...new Set([...seen.ids, ...ids])] }); return { ok: true } },
    },
  }
}
