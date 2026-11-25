/**
 * pasteAll.test.js — the robots paste (the owner, 2026-11-25): a whole form of Musaned's and of Enjaz's kind, mock
 * pages in a real Chrome, with the pasting off and on: the same values in the form itself, dropdowns and search lists
 * taken, only a box that does not keep its value filled the older way, alone; nothing presses Save. Times are printed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { findChrome, rmTmp } from './helpers/chrome.js'
import { MUSANED_FORM, ENJAZ_FORM } from './helpers/mockForms.js'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.ADAL_NO_BROWSER_START = '1'
process.env.JEV_ENABLED = 'false'
const CHROME = findChrome()

async function open(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-paste-'))
  // (A site that forbids eval, as many do.)
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.setHeader('content-security-policy', "script-src 'unsafe-inline'"); r.end(q.url === '/enjaz' ? ENJAZ_FORM : MUSANED_FORM) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: tmp, defaultViewport: { width: 1366, height: 900 }, args: ['--no-first-run', '--disable-gpu'] })
  t.after(async () => { await b.close().catch(() => {}); srv.close(); rmTmp(tmp); delete process.env.ADAL_PASTE_ALL })
  const page = await b.newPage()
  return { page, go: (p) => page.goto(`http://127.0.0.1:${srv.address().port}${p}`) }
}
const WANT = {
  m: 'Single', r: 'Muslim', career: 'House Maid', qualifications: ['Preparatory School'], language: 'None', hasExperience: 'No experience',
  skills: ['Babysitting', 'Hard worker', 'Nanny', 'Washing & ironing clothes', 'Dusting & cleaning', 'Washing kitchen dishes'],
  mobileNumber: '911223344', email: 'agency.office@example.com', children: 2, passportIssuePlace: 'Addis Ababa', issue: '2024-3-9',
  city: 'Addis Ababa', address: 'Kolfe Keraniyo', relativeContactName: 'TEST EMPLOYEE NAME', relativeContactKinship: 'cousin', relativeContactPhone: '922334455', relativeContactAddress: 'Addis Ababa',
}

test('Musaned\'s form: the same values off and on, much sooner', { skip: !CHROME && 'no Chrome', timeout: 200000 }, async (t) => {
  const { page, go } = await open(t)
  const w = await import('../src/services/musanedWorkflow.js'), P = await import('../src/services/pasteAll.js')
  const F = w._form
  const run = async (on) => {
    process.env.ADAL_PASTE_ALL = on ? '1' : '0'
    await go('/musaned')
    const logs = [], ctx = { onLog: (l, m) => logs.push(m), profileName: 'T' }, times = {}
    const at = async (name, fn) => { const t0 = Date.now(); await fn(); times[name] = Date.now() - t0 }
    const t0 = Date.now()
    await at('2 radios', async () => { await F.clickRadioByLabel(page, 'Marital Status', 'Single', ctx); await F.clickRadioByLabel(page, 'Religion', 'Muslim', ctx) })
    for (const [l, v] of [['Job', 'House Maid'], ['Education level', 'Preparatory School'], ['Languages', 'None'], ['Experience', 'No experience']]) await at(`list: ${l}`, () => F.typeAndCommitDropdown(page, l, v, ctx))
    await at('6 skills', () => F.fillSkillsByTyping(page, WANT.skills, ctx))
    await at('3 plain boxes', () => w.setFieldsByLabel(page, { 'Mobile Number': '911223344', 'E-Mail': 'agency.office@example.com', 'Passport Issue Place': 'Addis Ababa' }, ctx))
    await at('number spinner', async () => { await F.setFieldByLabel(page, 'Number Of Children', '2', ctx); await F.enterInField(page, 'Number Of Children', ctx) })
    await at('calendar', () => F.fillDateByLabel(page, 'Passport Issue Date', 'March 9, 2024', ctx))
    await at('6 plain boxes (one refuses scripts)', () => w.setFieldsByLabel(page, { 'City': 'Addis Ababa', 'Address': 'Kolfe Keraniyo', 'Relative name': 'TEST EMPLOYEE NAME', 'Relative kinship': 'cousin', 'Relative phone': '922334455', 'Relative address': 'Addis Ababa' }, ctx))
    times.whole = Date.now() - t0
    const model = await page.evaluate(() => window.model), saved = await page.evaluate(() => saved)
    return { times, model, saved, logs }
  }
  const off = await run(false), on = await run(true)
  console.log('Musaned mock, ms off → on:\n' + Object.keys(off.times).map(k => `  ${k.padEnd(38)} ${String(off.times[k]).padStart(6)} → ${on.times[k]}`).join('\n'))
  assert.deepEqual(off.model, WANT, 'off: ' + off.logs.filter(l => /✗|⚠/.test(l)).join(' | '))
  assert.deepEqual(on.model, WANT, 'on: ' + on.logs.filter(l => /✗|⚠/.test(l)).join(' | '))
  assert.equal(off.saved + on.saved, 0, 'nothing presses Save')
  // What was pasted together, and the one box alone.
  const together = on.logs.filter(l => /pasted together/.test(l)).join('\n')
  for (const n of ['Mobile Number', 'E-Mail', 'Passport Issue Place', 'City', 'Address', 'Relative name', 'Relative kinship', 'Relative address']) assert.match(together, new RegExp(`${n} = `))
  assert.doesNotMatch(together, /Relative phone|Number Of Children/)
  assert.ok(on.logs.some(l => /✓ Relative phone = "922334455"/.test(l)), 'the one that refused: the older way, alone')
  assert.equal(off.logs.some(l => /pasted together/.test(l)), false)
  assert.ok(on.times.whole < off.times.whole * 0.75, `${off.times.whole} → ${on.times.whole}`)
  void P
})

test('Enjaz\'s form: the same values off and on', { skip: !CHROME && 'no Chrome', timeout: 150000 }, async (t) => {
  const { page, go } = await open(t)
  const M = await import('../src/services/mofaVisa.js')
  const v = { visa_type: 'work', nationality: 'ethiopia', mission: 'addis', entries: 'single', validity: '90', duration: '90', visa_number: '1234567890', occupation: 'house ?work', family: 'ZENEBE', first: 'HIWOT', father: 'GETACHEW', passport: 'EP1234567', passport_type: 'ordinary', issue_date: '2024-03-09', expiry_date: '2029-03-08', birth_place: 'ADDIS ABABA', dob: '1999-12-19', religion: 'christian', marital: 'single', gender: 'female', qualification: 'Preparatory School', degree_source: 'ETHIOPIA', ksa_address: 'RIYADH', email: 'agency.office@example.com', sponsor_name: 'SAMPLE EMPLOYER', sponsor_id: '1000000001', sponsor_address: 'JEDDAH', sponsor_phone: '966500000000', transport: 'air', entry_date: '2026-12-24', purpose: 'Work', previous_nationality: 'no', travelled: 'no' }
  const run = async (on) => {
    process.env.ADAL_PASTE_ALL = on ? '1' : '0'
    await go('/enjaz')
    const logs = [], t0 = Date.now()
    const left = await M.fillForm(page, { onLog: (l, m) => logs.push(`${Date.now() - t0} ${m}`), profileName: 'T' }, v)
    return { ms: Date.now() - t0, left, logs, ...(await page.evaluate(() => ({ model: window.model, saved, cap: cap.value, values: Object.fromEntries([...document.querySelectorAll('input[type=text], select')].map(e => [e.id, e.tagName === 'SELECT' ? e.options[e.selectedIndex]?.text : e.value])) }))) }
  }
  const off = await run(false), on = await run(true)
  console.log(`Enjaz mock: the whole form ${off.ms} → ${on.ms} ms; left for a person: ${JSON.stringify(on.left)}`)
  // The box that puts its own value back ('ph') stayed empty the older way (nothing read it back): now seen, filled alone.
  assert.deepEqual({ ...on.values, ph: '' }, off.values); assert.equal(off.values.ph, '')
  const { ph, ...rest } = on.model; assert.deepEqual(rest, off.model); assert.equal(ph, '966500000000')
  assert.deepEqual(on.left, off.left)
  for (const [id, want] of [['fam', 'ZENEBE'], ['fir', 'HIWOT'], ['fat', 'GETACHEW'], ['em', 'agency.office@example.com'], ['sn', 'SAMPLE EMPLOYER'], ['ph', '966500000000'], ['ms', 'Addis Ababa'], ['ic', 'Ethiopia'], ['JOB_OR_RELATION_Id', 'House work'], ['DocumentNumber', '1234567890'], ['re', 'Christian']]) assert.equal(on.values[id], want, id)
  assert.equal(on.cap, '', 'the captcha is a person\'s'); assert.equal(on.saved + off.saved, 0)
  assert.ok(on.ms < off.ms * 0.6, `${off.ms} → ${on.ms}`)
})

test('what is never set as plain text; an error: the older way', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const { page, go } = await open(t)
  process.env.ADAL_PASTE_ALL = '1'
  await go('/musaned')
  const { setAll, lastKey } = await import('../src/services/pasteAll.js')
  const r = await setAll(page, [{ name: 'Job', value: 'House Maid' }, { name: 'Skills', value: 'x' }, { name: 'Number Of Children', value: '2' }, { name: 'Passport Issue Date', value: '2024' }, { name: 'City', value: 'Addis' }, { name: 'No Such Label', value: 'x' }, { name: 'Address', value: '' }])
  assert.deepEqual(r, { Job: 'alone', Skills: 'alone', 'Number Of Children': 'alone', 'Passport Issue Date': 'alone', City: 'ok', 'No Such Label': 'alone', Address: 'alone' })
  assert.deepEqual(await page.evaluate(() => window.model), { city: 'Addis' })
  assert.deepEqual(await setAll({ evaluate: async () => { throw new Error('gone') } }, [{ name: 'City', value: 'x' }]), { City: 'alone' })
  // A search box: in one piece, its last letter a key.
  await page.evaluate(() => { document.body.innerHTML = '<textarea id=q></textarea>'; window.ev = []; for (const e of ['input', 'keyup']) q.addEventListener(e, () => ev.push(e + ':' + q.value)) })
  await lastKey(page, await page.$('#q'), 'EP1234567')
  assert.deepEqual(await page.evaluate(() => ev), ['input:EP123456', 'input:EP1234567', 'keyup:EP1234567'])
  process.env.ADAL_PASTE_ALL = '0'
  assert.deepEqual(await setAll(page, [{ name: 'City', value: 'x' }]), { City: 'alone' })
})
