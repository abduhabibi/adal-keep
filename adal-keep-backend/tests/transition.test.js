import test from 'node:test'
import assert from 'node:assert/strict'
import { readPerson, findPeople, filesOf, nextPage, checkLink, newestFirst, madeHere, fileTier, prioritize, filesWaiting } from '../src/services/transition.js'

test('a person is read from any shape, and needs a real passport number', () => {
  const p = readPerson({ id: 7, name: 'Milki Aliyi', passport: { number: 'eq1743746', expiryDate: '31/08/2030' }, religion: { nameEn: 'Muslim' }, dob: '1999-11-30T00:00:00Z' })
  assert.equal(p.passport_number, 'EQ1743746')
  assert.equal(p.full_name, 'Milki Aliyi')
  assert.equal(p.passport_expiry_date, '2030-08-31')
  assert.equal(p.religion, 'Muslim')
  assert.equal(p.date_of_birth, '1999-11-30')
  assert.equal(readPerson({ name: 'An employer', passportNo: '-' }), null)
  assert.equal(readPerson({ passportNumber: 'EP1234567' }), null) // no name
  assert.equal(readPerson({ firstName: 'A', lastName: 'B', 'Passport No': 'EP1234567' }).full_name, 'A B')
})

test('table rows and nested answers are found', () => {
  assert.equal(findPeople({ data: { content: [{ fullName: 'A', passportNumber: 'EP1234567' }, { fullName: 'B', passportNumber: 'EP1234568' }, { fullName: 'C' }] } }).length, 2)
  assert.equal(findPeople([{ 'Full Name': 'A', 'Passport No.': 'EP1234567' }]).length, 1)
})

test('files go to the right field', () => {
  const f = filesOf({ fullBodyPhoto: '/up/b.jpg', passportImage: 'https://x.test/p.png', cvUrl: '/c.pdf', photo: '/f.webp', note: 'hello', logo: '/l.png' }, 'https://a.test')
  assert.deepEqual(f.map(x => x.field), ['Full Body Photo', 'Passport', 'CV', 'Photo'])
  assert.equal(f[0].url, 'https://a.test/up/b.jpg')
})

test('the next page of a list', () => {
  assert.equal(nextPage('https://a.test/l?page=0&size=2', {}, 2), 'https://a.test/l?page=1&size=2')
  assert.equal(nextPage('https://a.test/l?offset=20', {}, 20), 'https://a.test/l?offset=40')
  assert.equal(nextPage('https://a.test/l', { next: '/l?cursor=x' }, 2), 'https://a.test/l?cursor=x')
  assert.equal(nextPage('https://a.test/l', { total: 9 }, 2), 'https://a.test/l?page=2')
  assert.equal(nextPage('https://a.test/l', { total: 2 }, 2), null)
})

test('only a Pextran address is taken', () => {
  assert.equal(checkLink('zadulmead.agency.pextran.com/auth/signin'), 'https://zadulmead.agency.pextran.com/')
  assert.throws(() => checkLink('https://pextran.com.evil.test/'))
  assert.throws(() => checkLink(''))
})

test('EasyEnjaz: every file key is found, secrets are dropped, its own names are read', async () => {
  const { fileKeysOf, withoutSecrets, personOf } = await import('../src/services/easyEnjazCopy.js')
  const keys = fileKeysOf({ photoKey: 'a/p.jpg', passportKey: 'https://b2.test/a/pass.jpg', doc2Key: 'a/m.pdf', interviewKey: '', photo: null, somethingKey: 'a/x.pdf' })
  assert.deepEqual(keys, [{ field: 'Photo', key: 'a/p.jpg' }, { field: 'Passport', key: 'a/pass.jpg' }, { field: 'Medical Report', key: 'a/m.pdf' }, { field: 'Document', key: 'a/x.pdf' }])
  assert.deepEqual(withoutSecrets([{ name: 'A', passwordHash: 'x', token: 'y', inner: { password: 'z', ok: 1 } }]), [{ name: 'A', inner: { ok: 1 } }])
  const p = personOf({ fullName: 'A B', passportNo: 'EP1234567', applicationNo: 'E123', visaNo: '190', sponsorID: '10', sponsorPhone: '05', pasportExpiryDate: '2030-01-02T00:00:00', phoneNo: '09', contactPerson: 'C' }, readPerson)
  assert.equal(p.visa_application_number, 'E123')
  assert.equal(p.visa_number, '190')
  assert.equal(p.employer_id, '10')
  assert.equal(p.passport_expiry_date, '2030-01-02')
  assert.equal(p.phone_number, '09')
  assert.equal(p.emergency_name, 'C')
  assert.equal(personOf({ fullName: 'No passport' }, readPerson), null)
})

test('EasyEnjaz: a sign-in that runs out mid-copy waits for the person, then all are copied; a second visit goes on', async () => {
  const fs = await import('fs'), os = await import('os'), path = await import('path')
  const { default: knex } = await import('knex')
  const { copyEasyEnjaz } = await import('../src/services/easyEnjazCopy.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.integer('field_template_id'); t.string('name'); t.string('data_type'); t.integer('is_permanent'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('field_templates', t => { t.increments('id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('original_name'); t.string('path'); t.string('mimetype'); t.integer('size'); t.string('content_hash'); t.string('created_at'); t.string('updated_at') })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-'))
  const folder = path.join(dir, 'run')
  fs.mkdirSync(folder)
  const rows = [1, 2, 3, 4, 5].map(i => ({ id: `a${i}`, fullName: `P ${i}`, passportNo: `EP123456${i}`, visaNo: `19${i}` }))
  let valid = 'one', records = 0, signIns = 0, down = false
  const pdf = (n) => ({ status: 200, type: 'application/pdf', buffer: Buffer.from(`%PDF ${n}`) })
  const ask = async (token, url) => {
    if (down) return { status: 0 }
    if (token !== valid) return { status: 401 }
    if (url.includes('paged')) return { status: 200, type: 'application/json', text: JSON.stringify({ data: url.includes('inactive') ? [] : rows, totalCount: 5 }) }
    if (url.includes('/Reports/')) return pdf(url)
    if (/applicants\/a\d$/.test(url)) {
      if (++records === 3) { valid = 'two'; return { status: 401 } } // ran out here
      return { status: 200, type: 'application/json', text: '{}' }
    }
    return { status: 404 }
  }
  let st = {}, n = 0
  const base = {
    db, token: 'one', ask, folder, readPerson, set: p => { st = { ...st, ...p } }, state: () => st,
    save: async () => ++n, signIn: async () => { signIns++; return valid }, wait: async () => {},
  }
  // Stopped by a person after two: the rest stay for the next visit.
  let checks = 0
  await assert.rejects(copyEasyEnjaz({ ...base, check() { if (st.files >= 4 && ++checks > 1) throw new Error('Stopped') } }), /Stopped/)
  const progress = path.join(dir, 'easyenjaz-progress.json')
  assert.ok(fs.existsSync(progress))
  const after = JSON.parse(fs.readFileSync(progress, 'utf8')).length
  assert.ok(after >= 1 && after < 5)
  await copyEasyEnjaz({ ...base, token: valid, check() {} })
  assert.equal(signIns, 1)
  assert.equal(st.failed || 0, 0)
  assert.equal(fs.readdirSync(path.join(folder, 'records')).length, 5)
  assert.equal(fs.existsSync(progress), false) // a whole copy is over
  // No one is lost to the sign-in: each has a visa and a CV.
  const names = (await db('files').select('original_name')).map(f => f.original_name)
  for (const r of rows) for (const kind of ['Visa', 'CV']) assert.ok(names.includes(`${r.passportNo}-EasyEnjaz-${kind}.pdf`), `${r.id} ${kind}`)
  // The internet goes: a list read in part is an error, never a shorter list.
  down = true
  await assert.rejects(copyEasyEnjaz({ ...base, token: valid, check() {} }), /whole list/)
  await db.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('EasyEnjaz: people whose files EasyEnjaz lost never stop the copy, and are done after two visits', async () => {
  const fs = await import('fs'), os = await import('os'), path = await import('path')
  const { default: knex } = await import('knex')
  const { copyEasyEnjaz } = await import('../src/services/easyEnjazCopy.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.integer('field_template_id'); t.string('name'); t.string('data_type'); t.integer('is_permanent'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('field_templates', t => { t.increments('id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('original_name'); t.string('path'); t.string('mimetype'); t.integer('size'); t.string('content_hash'); t.string('created_at'); t.string('updated_at') })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ee2-'))
  const folder = path.join(dir, 'run'); fs.mkdirSync(folder)
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `b${i}`, fullName: `P ${i}`, passportNo: `EP12345${String(i).padStart(2, '0')}` }))
  const ask = async (token, url) => {
    if (url.includes('paged')) return { status: 200, type: 'application/json', text: JSON.stringify({ data: url.includes('inactive') ? [] : rows, totalCount: 25 }) }
    if (url.includes('/Reports/')) return { status: 200, type: 'application/pdf', buffer: Buffer.from('%PDF') }
    if (url.includes('file-url') || url.includes('public-url')) return { status: 404 } // the file is gone on their side
    if (/applicants\/b\d+$/.test(url)) return { status: 200, type: 'application/json', text: JSON.stringify({ photoKey: 'x/gone.jpg' }) }
    return { status: 404 }
  }
  let st = {}, n = 0
  const base = { db, token: 't', ask, folder, readPerson, set: p => { st = { ...st, ...p } }, state: () => st, save: async () => ++n, signIn: async () => 't', wait: async () => {}, check() {} }
  await copyEasyEnjaz(base)                 // all 25 missing a file: no stop
  assert.equal(fs.readdirSync(path.join(folder, 'records')).length, 25)
  await copyEasyEnjaz(base)                 // second visit: they count as done
  assert.equal(fs.existsSync(path.join(dir, 'easyenjaz-progress.json')), false)
  await db.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Pextran brokers: found in any answer, made once, filled, and given to their people', async () => {
  const { default: knex } = await import('knex')
  const { collectBrokers, saveBrokers, brokerIdOf } = await import('../src/services/siteBrokers.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('brokers', t => { t.increments('id'); t.string('name'); t.string('logo'); t.string('address'); t.string('contact1'); t.string('contact2'); t.string('notes'); t.timestamps(true, true) })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('passport_number'); t.integer('broker_id') })
  await db('brokers').insert({ name: 'Ayele Broker', contact1: '' })        // typed here before
  await db('profiles').insert([{ passport_number: 'EP1' }, { passport_number: 'EP2' }, { passport_number: 'EP3', broker_id: 99 }])
  const found = new Map()
  collectBrokers({ data: [{ id: 'k1', name: 'Ayele Broker', phone: '+251 911 223344' }, { id: 'k2', fullName: 'Sara Dalala', mobile: '0922334455', city: 'Dessie', password: 'x' }] }, 'https://a.pextran.com/api/brokers', found)
  collectBrokers({ items: [{ id: 'p1', fullName: 'A worker', passportNumber: 'EP1' }] }, 'https://a.pextran.com/api/candidates', found)
  assert.equal(found.has('p1'), false) // a person is not a broker
  assert.equal(brokerIdOf({ broker: { id: 'k2' } }), 'k2')
  const people = [{ raw: { brokerId: 'k1' }, profileId: 1 }, { raw: { brokerId: 'k2' }, profileId: 2 }, { raw: { brokerId: 'k2' }, profileId: 3 }]
  const r = await saveBrokers(db, people, found, 'Pextran')
  assert.deepEqual(r, { created: 1, filled: 1, assigned: 2 })
  const all = await db('brokers').orderBy('id')
  assert.equal(all.length, 2)
  assert.equal(all[0].contact1, '+251 911 223344')                 // filled the empty number
  assert.equal(all[1].contact1, '0922334455')
  assert.ok(!/password/.test(all[1].notes))
  assert.equal((await db('profiles').where('id', 3).first()).broker_id, 99) // a broker given here stays
  const again = await saveBrokers(db, people, found, 'Pextran')
  assert.equal(again.created, 0)                                    // never twice
  await db.destroy()
})

test('EnjazPlus: every employee of every page, her files, a sign-out midway, and going on later', async () => {
  const fs = await import('fs'), os = await import('os'), path = await import('path')
  const { default: knex } = await import('knex')
  const { copyEnjazPlus, personOf } = await import('../src/services/enjazPlusCopy.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.integer('field_template_id'); t.string('name'); t.string('data_type'); t.integer('is_permanent'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('field_templates', t => { t.increments('id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('original_name'); t.string('path'); t.string('mimetype'); t.integer('size'); t.string('content_hash'); t.string('created_at'); t.string('updated_at') })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-'))
  const folder = path.join(dir, 'run'); fs.mkdirSync(folder)
  const people = Array.from({ length: 120 }, (_, i) => ({ _id: `e${i}`, givenName: `Given${i}`, surName: 'Sur', passportNumber: `ep90000${String(i).padStart(2, '0')}`, facePhoto: `https://cdn.test/f${i}.jpg`, additionalData: { labourId: `ef${i}`, appliedCountry: 'SAUDI_ARABIA' }, address: { telephone: '0911' } }))
  let calls = 0, cookie = 'a=1'
  const ask = async (url, opts) => {
    const { variables } = JSON.parse(opts.body)
    if (opts.headers.Cookie !== cookie) return { status: 401, json: async () => ({ errors: [{ message: 'Not authorized' }] }) }
    if (++calls === 2) { cookie = 'a=2'; return { status: 401, json: async () => ({ errors: [{ message: 'Not authorized' }] }) } } // signed out here
    return { status: 200, ok: true, json: async () => ({ data: { employees: { totalCount: people.length, employees: people.slice(variables.skip, variables.skip + variables.take) } } }) }
  }
  const download = async () => ({ ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => Buffer.from('jpg' + Math.random()) })
  let st = {}, n = 0, signIns = 0
  const saved = []
  const base = { db, folder, readPerson, ask, download, wait: async () => {}, set: p => { st = { ...st, ...p } }, state: () => st,
    save: async (p) => { saved.push(p); return ++n }, signIn: async () => { signIns++; return { cookie } }, check() {} }
  await copyEnjazPlus({ ...base, token: { cookie: 'a=1' }, limit: 70 })    // a first visit stops after 70
  assert.equal(st.people, 120)
  assert.equal(signIns, 1)
  await copyEnjazPlus({ ...base, token: { cookie } })                       // the next goes on
  assert.equal(saved.length, 120)
  assert.equal(fs.readdirSync(path.join(folder, 'records')).length, 120)
  assert.equal(st.files, 120)
  assert.equal(fs.existsSync(path.join(dir, 'enjazplus-progress.json')), false)
  const p = personOf(people[3], readPerson)
  assert.equal(p.full_name, 'Given3 Sur'); assert.equal(p.passport_number, 'EP9000003'); assert.equal(p.labor_id, 'EF3'); assert.equal(p.destination_country, 'Saudi Arabia')
  await db.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Musaned: the HR pool page by page as the page shows it (10 a page), statuses updated, details and photos for the new, going on later', async () => {
  const fs = await import('fs'), os = await import('os'), path = await import('path')
  const { default: knex } = await import('knex')
  const { copyMusaned, statusOf } = await import('../src/services/musanedCopy.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('passport_number'); t.string('musaned_stage'); t.string('updated_at') })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.integer('field_template_id'); t.string('name'); t.string('data_type'); t.integer('is_permanent'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('field_templates', t => { t.increments('id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('original_name'); t.string('path'); t.string('mimetype'); t.integer('size'); t.string('content_hash'); t.string('created_at'); t.string('updated_at') })
  // Two already here: one gets a newer contract stage, one keeps hers (a plain status never overwrites it).
  await db('profiles').insert([{ full_name: 'Had 0', passport_number: 'EP1000', musaned_stage: 'EPRO APPROVAL' }, { full_name: 'Had 1', passport_number: 'EP1001', musaned_stage: 'FMOL APPROVAL' }])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-'))
  const folder = path.join(dir, 'run'); fs.mkdirSync(folder)
  const people = Array.from({ length: 23 }, (_, i) => ({ id: 1000 + i, name: `Person ${i}`, passportNumber: `ep${1000 + i}`, status: i === 0 ? 'FMOL APPROVED' : i === 1 ? 'AVAILABLE' : 'AVAILABLE' }))
  let asked = []
  const pool = () => (async function* () { for (let p = 0; p * 10 < people.length; p++) yield { content: people.slice(p * 10, p * 10 + 10), totalElements: people.length, page: p + 1, pages: 3, total: people.length } })()
  const ask = async (url) => {
    const u = new URL(url); asked.push(u.pathname)
    if (/\/api\/search\//.test(u.pathname)) throw new Error('the list is never asked for apart from the page')
    const m = u.pathname.match(/^\/api\/hrpool\/(\d+)(\/photo\/(\w+))?$/)
    if (m && !m[2]) return { ok: true, status: 200, json: async () => ({ name: `Person ${m[1]}`, religion: 'MUSLIM', dateOfBirthGregorian: '1999-01-02' }) }
    if (m) return { ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => Buffer.from(m[3] + m[1]) }
    return { ok: false, status: 404 }
  }
  let st = {}
  const saved = []
  const contractsAsked = []
  const base = { db, folder, readPerson, ask, pool, wait: async () => {}, contracts: async (id) => { contractsAsked.push(id); return { state: 'chosen' } }, set: p => { st = { ...st, ...p } }, state: () => st,
    save: async (p) => { saved.push(p); const had = await db('profiles').where('passport_number', p.passport_number).first(); if (had) return had.id; const [id] = await db('profiles').insert({ full_name: p.full_name, passport_number: p.passport_number, musaned_stage: p.musaned_stage }); return id }, check() {} }
  await copyMusaned({ ...base, token: { auth: 'Bearer one' }, limit: 10 })
  await copyMusaned({ ...base, token: { auth: 'Bearer one' } })
  assert.equal(st.people, 23)
  assert.equal((await db('profiles').where('passport_number', 'EP1000').first()).musaned_stage, 'FMOL APPROVED')
  assert.equal((await db('profiles').where('passport_number', 'EP1001').first()).musaned_stage, 'FMOL APPROVAL')
  assert.equal(await db('profiles').count('* as n').then(r => r[0].n), 23)
  assert.equal(st.files, 46)                                      // passport and photo for all 23 (none had any)
  assert.equal(asked.filter(p => /^\/api\/hrpool\/\d+$/.test(p)).length, 33)   // every detail of each of the newest: 10, then all 23
  assert.equal(contractsAsked.length, 2)                          // the chosen one (FMOL APPROVED), on each of the two runs
  assert.equal(saved.find(p => p.passport_number === 'EP1002').religion, 'Muslim')
  assert.equal(statusOf({ status: { nameEn: 'Visa Issued' } }), 'Visa Issued')
  assert.equal(fs.existsSync(path.join(dir, 'musaned-progress.json')), false)
  await db.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a move: newest girls first, simple files first, made-here papers skipped, Prioritize only for a waiting girl', () => {
  const g = (id, createdAt) => ({ raw: { id, ...(createdAt ? { createdAt } : {}) } })
  assert.deepEqual(newestFirst([g(1, '2026-01-01'), g(2, '2026-11-01'), g(3, '2026-05-01')]).map(x => x.raw.id), [2, 3, 1])
  assert.deepEqual(newestFirst([g(1), g(2), g(3)]).map(x => x.raw.id), [1, 2, 3]) // no dates: as the list showed them (page 1 = newest)
  assert.equal(madeHere({ field: 'CV' }), true)
  assert.equal(madeHere({ field: 'Visa' }), true)
  assert.equal(madeHere({ field: 'Other', label: 'AppointmentSlip' }), true)
  assert.equal(madeHere({ field: 'Other', label: 'payment receipt' }), true)
  assert.equal(madeHere({ field: 'Passport', label: 'PassportScanImage' }), false)
  assert.equal(madeHere({ field: 'Medical Report', label: 'medicalResult' }), false)
  assert.deepEqual([{ field: 'Medical Report' }, { field: 'Full Body Photo' }, { field: 'Passport' }, { field: 'Photo' }].map(fileTier), [2, 1, 0, 0])
  assert.deepEqual(filesWaiting(), [])
  assert.equal(prioritize(12345), false)
  const files = filesOf({ cvUrl: 'https://x/a.pdf', visaCopyUrl: 'https://x/v.pdf', passportUrl: 'https://x/p.jpg' }, 'https://x')
  assert.deepEqual(files.filter(f => !madeHere(f)).map(f => f.field), ['Passport'])
  assert.equal(readPerson({ passportNumber: 'EP1234567', fullName: 'A B', applicationNumber: 'E123' }).visa_application_number, 'E123')
})
