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
