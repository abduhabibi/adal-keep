import test from 'node:test'
import assert from 'node:assert/strict'
import { readPerson, findPeople, filesOf, nextPage, checkLink } from '../src/services/transition.js'

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
