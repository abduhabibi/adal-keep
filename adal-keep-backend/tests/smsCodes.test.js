// LMIS's SMS code from the agency's phone (asked on 2026-11-16): to the robot
// that pressed Sign In (the same LMIS account's), typed there and shown in no
// tray; nobody in Adal Keep asked for it — every PC's tray shows it.
import test from 'node:test'
import assert from 'node:assert/strict'

const fresh = async (tabs = []) => {
  const s = await import(`../src/services/smsCodes.js?t=${Math.random()}`)
  // Each fake page says its own LMIS account (page.acct).
  s._setBrowsersForTest(async () => tabs, async (db, page) => page.acct || null)
  return s
}

test('nobody asked and no LMIS tab waits: the code goes to every tray', async () => {
  const s = await fresh()
  s.addSmsCode({ code: '123456', account: 'nuzla · 0911000000' })
  assert.equal(s.listSmsCodes().length, 0)   // not while its PC is looked for
  await s.settled()
  assert.deepEqual(s.listSmsCodes().map(c => c.code), ['123456'])
  assert.equal(s.takeSmsCode(0), '123456')   // a robot that comes later may still use it
})

test('a robot pressed Sign In: the code is that robot\'s, not the trays\'', async () => {
  const s = await fresh()
  const w = s.waitForSmsCode({ run: 7, account: { phone: '+251 911 000 000', name: 'nuzla' } })
  const r = s.addSmsCode({ code: '654321', account: 'nuzla · 0911000000' })
  assert.equal(r.to, 'robot'); assert.equal(r.run, 7)
  assert.equal(s.listSmsCodes().length, 0)
  assert.equal(s.takeSmsCode(0, w), '654321')
  assert.equal(s.takeSmsCode(0, w), null)     // used once
  s.stopWaiting(w)
})

test('two robots: each gets the code of its own LMIS account', async () => {
  const s = await fresh()
  const a = s.waitForSmsCode({ run: 1, account: { phone: '0911000000', name: 'nuzla' } })
  const b = s.waitForSmsCode({ run: 2, account: { phone: '0922000000', name: 'ZAD' } })
  assert.equal(s.addSmsCode({ code: '2222', account: 'ZAD · 0922000000' }).run, 2)
  assert.equal(s.addSmsCode({ code: '1111', account: 'nuzla · 0911000000' }).run, 1)
  assert.equal(s.takeSmsCode(0, a), '1111')
  assert.equal(s.takeSmsCode(0, b), '2222')
})

test('the phone named no account: the robot waiting longest gets it', async () => {
  const s = await fresh()
  const first = s.waitForSmsCode({ run: 1, account: { phone: '0911000000' } })
  s.waitForSmsCode({ run: 2, account: { phone: '0922000000' } })
  s.addSmsCode({ code: '3333', account: '' })
  await s.settled()
  assert.equal(s.takeSmsCode(0, first), '3333')
})

test('a robot that gave up: its code shows in the trays after all', async () => {
  const s = await fresh()
  const w = s.waitForSmsCode({ run: 9, account: { phone: '0911000000' } })
  s.addSmsCode({ code: '4444', account: 'x · 0911000000' })
  assert.equal(s.listSmsCodes().length, 0)
  s.stopWaiting(w)
  assert.deepEqual(s.listSmsCodes().map(c => c.code), ['4444'])
})

test('the same SMS sent twice counts once; a non-code is refused', async () => {
  const s = await fresh()
  s.addSmsCode({ code: '5555' })
  assert.equal(s.addSmsCode({ code: '5555' }).twice, true)
  await s.settled()
  assert.equal(s.listSmsCodes().length, 1)
  assert.throws(() => s.addSmsCode({ code: '12' }))
})

// A page that looks like LMIS's code page, enough for tabManager's helpers.
const fakePage = (url, { box = true } = {}) => {
  const page = { typed: null, pressed: false, url: () => url }
  page.evaluate = async (fn) => {

    if (typeof fn !== 'string') { page.pressed = true; return }   // pressCodeButton
    if (fn.endsWith('.length > 0')) return box                     // codeBoxUp
    if (!box) return ''                                            // typeCodeInto
    page.typed = JSON.parse(fn.slice(fn.lastIndexOf(', ') + 2, -1))
    return 'box'
  }
  return page
}

test('a person pressed Sign In on a Companion: the code is typed into that PC LMIS tab, no tray', async () => {
  const other = fakePage('https://musaned.com.sa/x')
  const lmisNoBox = fakePage('https://lmis.gov.et/home', { box: false })
  const lmis = fakePage('https://lmis.gov.et/auth/realms/x/login-actions')
  const s = await fresh([
    { name: 'this PC', browser: { pages: async () => [other, lmisNoBox] } },
    { name: 'Reception PC', browser: { pages: async () => [lmis] } },
  ])
  assert.equal(s.addSmsCode({ code: '778899', account: 'nuzla · 0911000000' }).to, 'looking')
  await s.settled()
  assert.equal(lmis.typed, '778899')
  assert.equal(lmis.pressed, true)
  assert.equal(lmisNoBox.typed, null)
  assert.equal(other.typed, null)
  assert.equal(s.listSmsCodes().length, 0)
  assert.equal(s.takeSmsCode(0), null)       // used
})

test('a robot waiting still gets its own code (no tab is touched)', async () => {
  const lmis = fakePage('https://lmis.gov.et/auth')
  const s = await fresh([{ name: 'Reception PC', browser: { pages: async () => [lmis] } }])
  const w = s.waitForSmsCode({ run: 3, account: { phone: '0911000000' } })
  assert.equal(s.addSmsCode({ code: '1212', account: 'x · 0911000000' }).to, 'robot')
  await s.settled()
  assert.equal(lmis.typed, null)
  assert.equal(s.takeSmsCode(0, w), '1212')
})

const nuzla = { name: 'nuzla', phone: '0911000000' }
const zad = { name: 'ZAD', phone: '0922000000' }

test('two PCs waiting at once (two accounts): each code goes into its own account tab', async () => {
  const a = Object.assign(fakePage('https://lmis.gov.et/auth/x'), { acct: nuzla })
  const b = Object.assign(fakePage('https://lmis.gov.et/auth/y'), { acct: zad })
  const s = await fresh([
    { name: 'this PC', browser: { pages: async () => [a] } },
    { name: 'Reception PC', browser: { pages: async () => [b] } },
  ])
  s.addSmsCode({ code: '2020', account: 'ZAD · 0922000000' })
  await s.settled()
  assert.equal(b.typed, '2020'); assert.equal(a.typed, null)
  s.addSmsCode({ code: '1010', account: 'nuzla · 0911000000' })
  await s.settled()
  assert.equal(a.typed, '1010'); assert.equal(b.typed, '2020')
})

test('a robot waits for one account, a person for another: the person gets the code of theirs', async () => {
  const b = Object.assign(fakePage('https://lmis.gov.et/auth/y'), { acct: zad })
  const s = await fresh([{ name: 'Reception PC', browser: { pages: async () => [b] } }])
  const w = s.waitForSmsCode({ run: 4, account: nuzla })
  s.addSmsCode({ code: '3030', account: 'ZAD · 0922000000' })
  await s.settled()
  assert.equal(b.typed, '3030')
  assert.equal(s.takeSmsCode(0, w), null)       // not the robot's
  s.addSmsCode({ code: '4040', account: 'nuzla · 0911000000' })
  assert.equal(s.takeSmsCode(0, w), '4040')
})

test('two SIMs in one phone: the SIM that got the SMS says which account', async () => {
  const s = await fresh()
  const one = s.waitForSmsCode({ run: 1, account: nuzla })
  const two = s.waitForSmsCode({ run: 2, account: zad })
  const both = '1:nuzla · 0911000000 | 2:ZAD · 0922000000'
  assert.equal(s.addSmsCode({ code: '5050', account: both, sim: 2 }).run, 2)
  assert.equal(s.addSmsCode({ code: '6060', account: both, sim: 1 }).run, 1)
  assert.equal(s.takeSmsCode(0, two), '5050')
  assert.equal(s.takeSmsCode(0, one), '6060')
  assert.deepEqual(s.parseAccounts(both), [{ sim: 1, name: 'nuzla', phone: '0911000000' }, { sim: 2, name: 'ZAD', phone: '0922000000' }])
})
