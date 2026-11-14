// A whole Pextran move against a pretend site: brokers first, every page of
// recruits, each girl's own record, her photos before her other files, three
// tries on a dropping line, and a second move that only fetches what is left.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const ORIGIN = 'https://demo.agency.pextran.com'
const girls = Array.from({ length: 25 }, (_, i) => ({
  id: `g${i}`, brokerId: i % 2 ? 'b1' : 'b2', createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  firstName: `GIRL${String.fromCharCode(65 + i)}`, lastName: 'TEST', passportNumber: `EP${String(1000000 + i)}`,
}))
const record = (g) => ({ data: { ...g, religion: 'Muslim', placeOfBirth: 'ADDIS', medias: [
  { type: 'PassportScanImage', url: `https://files.test/${g.id}/passport.jpg` },
  { type: 'FullBodyPhoto', url: `https://files.test/${g.id}/full.jpg` },
  { type: 'MedicalReport', url: `https://files.test/${g.id}/medical.pdf` },
  { type: 'CV', url: `https://files.test/${g.id}/cv.pdf` },                 // made in Adal Keep: never copied
  { type: 'VisaCopy', url: `https://files.test/${g.id}/visa.pdf` },          // made in Adal Keep: never copied
], passportSizePhotoUrl: `https://files.test/${g.id}/photo.jpg` } })
const listPage = (p) => ({ data: { data: girls.slice((p - 1) * 20, p * 20), total: girls.length, page: p, pageSize: 20 } })
const brokers = { data: { data: [{ id: 'b1', firstName: 'ALI', lastName: 'BROKER', phone: '0911000001' }, { id: 'b2', firstName: 'SARA', lastName: 'BROKER', phone: '0911000002' }], total: 2, page: 1, pageSize: 20 } }

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
let tries = new Map(), downloads = []
function site(url) {
  const u = new URL(url)
  if (u.pathname === '/api/brokers') return { json: brokers }
  if (u.pathname === '/api/registration') return { json: listPage(Number(u.searchParams.get('page') || 1)) }
  const one = u.pathname.match(/^\/api\/registration\/(g\d+)$/)
  if (one) return { json: record(girls.find(g => g.id === one[1])) }
  if (u.hostname === 'files.test') {
    const n = (tries.get(url) || 0) + 1
    tries.set(url, n)
    if (n === 1) return { status: 503 }                           // the line drops once for every file
    downloads.push(u.pathname)
    return { bin: /\.pdf$/.test(u.pathname) ? Buffer.from('%PDF-1.4 ' + u.pathname) : Buffer.concat([JPG, Buffer.from(u.pathname)]), type: /\.pdf$/.test(u.pathname) ? 'application/pdf' : 'image/jpeg' }
  }
  return { status: 404 }
}
const answer = (r) => r.status ? new Response('no', { status: r.status })
  : r.json ? new Response(JSON.stringify(r.json), { headers: { 'content-type': 'application/json' } })
  : new Response(r.bin, { headers: { 'content-type': r.type } })

function fakePage() {
  let at = 'about:blank', handlers = []
  const page = {
    url: () => at,
    on: (ev, fn) => { if (ev === 'response') handlers.push(fn) },
    off: () => { handlers = [] },
    isClosed: () => false, bringToFront: async () => {}, close: async () => {},
    goto: async (to) => {
      at = to
      const p = new URL(to).pathname
      const api = p.startsWith('/brokers') ? `${ORIGIN}/api/brokers?page=1&pageSize=20` : p.startsWith('/recruits') ? `${ORIGIN}/api/registration?page=1&pageSize=20` : null
      if (api) {
        const json = site(api).json
        for (const h of handlers) await h({ url: () => api, status: () => 200, headers: () => ({ 'content-type': 'application/json' }), json: async () => json,
          request: () => ({ resourceType: () => 'fetch', method: () => 'GET', headers: () => ({ authorization: 'Bearer t' }), postData: () => null }) })
      }
    },
    // The page's own work runs here, with this pretend site behind fetch.
    evaluate: async (fn, ...args) => {
      if (typeof fn !== 'function') return null
      const src = fn.toString()
      if (/querySelectorAll|document\.|location\./.test(src) && !/credentials: 'include'/.test(src)) {
        if (/password/.test(src)) return false   // not a sign-in page
        return /tables?|tr\b/.test(src) ? [] : /\bhref\b|links/.test(src) ? [] : false
      }
      return fn(...args)
    },
  }
  return page
}

test('Pextran move: brokers, every page, text first, photos first, 3 tries, goes on later', async () => {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => {
    t.increments('id'); for (const c of ['full_name', 'first_name', 'last_name', 'passport_number', 'religion', 'place_of_birth', 'created_by', 'created_at', 'updated_at']) t.string(c)
    t.integer('broker_id')
  })
  await db.schema.createTable('brokers', t => { t.increments('id'); for (const c of ['name', 'contact1', 'contact2', 'address', 'notes', 'logo']) t.string(c); t.timestamps(true, true) })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.integer('field_template_id'); t.string('name'); t.string('data_type'); t.integer('is_permanent'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); for (const c of ['original_name', 'path', 'mimetype', 'content_hash', 'created_at', 'updated_at']) t.string(c); t.integer('size') })
  await db.schema.createTable('field_templates', t => { t.increments('id'); t.string('name') })

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => answer(site(String(url)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-pextran-test-'))
  const order = []
  try {
    const { startTransition, transitionStates } = await import('../src/services/transition.js')
    const go = async () => {
      const page = fakePage()
      startTransition(db, 'pextran', `${ORIGIN}/`, { page, browser: {}, dir, sendAway: async () => {}, keepAwake: () => () => {} })
      for (let i = 0; i < 2400; i++) {
        await new Promise(r => setTimeout(r, 100))
        const s = transitionStates().pextran
        if (['done', 'failed', 'stopped'].includes(s.status)) return s
      }
      throw new Error('the move did not finish')
    }
    const s = await go()
    assert.equal(s.status, 'done', s.error || '')
    assert.equal(await db('profiles').count('* as n').first().then(r => r.n), 25)            // every page
    assert.equal(await db('brokers').count('* as n').first().then(r => r.n), 2)              // brokers made
    assert.equal(await db('profiles').whereNotNull('broker_id').count('* as n').first().then(r => r.n), 25) // each girl her broker
    assert.equal((await db('profiles').where('passport_number', 'EP1000003').first()).religion, 'Muslim')    // her own record's text
    const kinds = await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id').select('profile_fields.name').then(r => r.map(x => x.name))
    assert.equal(kinds.filter(k => k === 'Photo').length, 25)
    assert.equal(kinds.filter(k => k === 'Full Body Photo').length, 25)
    assert.equal(kinds.filter(k => k === 'Passport').length, 25)
    assert.equal(kinds.filter(k => k === 'Medical Report').length, 25)
    assert.ok(!kinds.includes('CV') && !kinds.includes('Visa'))                              // not copied
    // Photos of everybody before any passport, passports before other documents; the newest girl first.
    const firstPassport = downloads.findIndex(d => /passport/.test(d)), lastPhoto = Math.max(...downloads.map((d, i) => /photo|full/.test(d) ? i : -1))
    const firstOther = downloads.findIndex(d => /medical/.test(d)), lastPassport = Math.max(...downloads.map((d, i) => /passport/.test(d) ? i : -1))
    assert.ok(lastPhoto < firstPassport && lastPassport < firstOther)
    assert.ok(/g24\//.test(downloads[0]))
    assert.ok([...tries.values()].every(n => n === 2))                                       // each tried again after the drop

    // A second move: everything is known and done — no file is fetched again.
    downloads = []; tries = new Map()
    const again = await go()
    assert.equal(again.status, 'done')
    assert.equal(downloads.length, 0)
    assert.equal(await db('profiles').count('* as n').first().then(r => r.n), 25)
  } finally {
    globalThis.fetch = realFetch
    fs.rmSync(dir, { recursive: true, force: true })
    await db.destroy()
  }
})
