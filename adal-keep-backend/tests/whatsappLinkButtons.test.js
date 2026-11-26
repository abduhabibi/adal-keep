/**
 * whatsappLinkButtons.test.js — linking by code when WhatsApp's internal modules are gone
 * (the owner, 2026-11-26: the number typed, nothing continued). A mock of today's /login
 * page in a hidden browser: no window.require, only its buttons. The number in every form.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { phoneDigits, masked, codeFromButtons, whyNoPage, noteStep, linkLog, _resetSteps } from '../src/services/waLinkCode.js'

test('the number in every form a person types', () => {
  for (const v of ['+251 911 234 567', '251911234567', '0911234567', '0911 23 45 67', '911234567', '00251911234567', '+251 0911234567', ' +251-911-234-567 '])
    assert.equal(phoneDigits(v), '251911234567', v)
  assert.equal(phoneDigits('0711234567'), '251711234567')
  assert.equal(phoneDigits('+966 55 123 4567'), '966551234567')
  assert.equal(masked('251911234567'), '…567')
})

test('the steps are kept, numbers masked by the caller', () => {
  _resetSteps()
  noteStep('k', 'Connect pressed for …567'); noteStep('k', 'Failed', 'No internet on this PC.')
  const l = linkLog('k')
  assert.equal(l.length, 2); assert.equal(l[1].error, 'No internet on this PC.')
  assert.ok(!JSON.stringify(l).includes('911234'))
})

test('why WhatsApp\'s page did not come: no internet, or only WhatsApp', async () => {
  assert.match(await whyNoPage(() => Promise.reject(new Error('ENOTFOUND'))), /No internet/)
  assert.match(await whyNoPage(() => Promise.resolve({ address: '1.2.3.4' })), /not loading/)
})

// Today's /login page (probed 2026-11-26): "Log in with phone number", a box that keeps
// "+251 " by itself, Next, then the code one character a box. No window.require at all.
const PAGE = (mode) => `<!doctype html><body>
<div id="qr"><canvas width="10" height="10"></canvas><div role="button" id="pl">Log in with phone number</div></div>
<div id="form" style="display:none"><p>Enter phone number</p><input type="text" aria-label="Type your phone number to log in to WhatsApp" value="+251 "><button id="next">Next</button></div>
<div id="code" style="display:none"></div>
<script>
delete window.require
const inp = document.querySelector('input')
pl.onclick = () => { qr.style.display = 'none'; form.style.display = '' }
inp.addEventListener('input', () => { if (!inp.value.replace(/\\D/g, '').startsWith('251')) inp.value = '+251 ' + inp.value.replace(/^\\+?/, '') })
next.onclick = () => setTimeout(() => {
  window.__typed = inp.value.replace(/\\D/g, '')
  if (${JSON.stringify(mode)} === 'refuse') { form.insertAdjacentHTML('beforeend', '<div role="alert">Invalid phone number. Please try again.</div>'); return }
  form.style.display = 'none'; code.style.display = ''
  code.innerHTML = '<p>Enter code on phone</p>' + [...'K92BX74Q'].map(c => '<span>' + c + '</span>').join('')
}, 600)
</script></body>`

async function browser() {
  const { findBrowserExecutable } = await import('../src/services/browser.js')
  const exe = findBrowserExecutable() || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'].find(f => fs.existsSync(f))
  if (!exe) return null
  const { default: puppeteer } = await import('puppeteer-core').catch(() => import('puppeteer'))
  return puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
}

test('the page\'s own buttons give the code (no internal modules), the number never doubled', { timeout: 60_000 }, async (t) => {
  const b = await browser(); if (!b) return t.skip('no browser here')
  try {
    const p = await b.newPage(); await p.setContent(PAGE('ok'))
    const steps = []
    const r = await codeFromButtons(p, '251911234567', (s) => steps.push(s))
    assert.equal(r.code, 'K92BX74Q')
    assert.equal(await p.evaluate(() => window.__typed), '251911234567')
    assert.ok(steps.some(s => /Log in with phone number/.test(s)) && steps.some(s => /Typing/.test(s)) && steps.some(s => /Waiting for WhatsApp's code/.test(s)))
    assert.ok(!steps.join(' ').includes('911234'), 'the number masked in the steps')
  } finally { await b.close() }
})

test('a refused number says WhatsApp\'s own words', { timeout: 60_000 }, async (t) => {
  const b = await browser(); if (!b) return t.skip('no browser here')
  try {
    const p = await b.newPage(); await p.setContent(PAGE('refuse'))
    const r = await codeFromButtons(p, '251911234567')
    assert.equal(r.refused, true); assert.match(r.error, /refused the number: Invalid phone number/)
  } finally { await b.close() }
})

test('a page without the button says so (WhatsApp changed its page)', { timeout: 30_000 }, async (t) => {
  const b = await browser(); if (!b) return t.skip('no browser here')
  try {
    const p = await b.newPage(); await p.setContent('<body><canvas></canvas><p>Something else</p></body>')
    const r = await codeFromButtons(p, '251911234567')
    assert.match(r.error, /no "Log in with phone number" button/)
  } finally { await b.close() }
})

test('linkByCode end to end on the mock page: every step said, the code, the X', { timeout: 90_000 }, async (t) => {
  const b = await browser(); if (!b) return t.skip('no browser here')
  process.env.ACCOUNT_VAULT_KEY ||= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-btn-')), 'k')
  delete process.env.ADAL_ISOLATED; delete process.env.ADAL_WHATSAPP
  const W = await import('../src/services/whatsapp.js')
  const key = 'mock-link-test'
  try {
    const p = await b.newPage(); await p.setContent(PAGE('ok'))
    W._setClientForTests(key, { pupPage: p, options: {} }, { status: 'qr' })
    const seen = new Set()
    const first = await W.linkByCode(null, key, '0911 234 567')
    seen.add(first.step)
    for (let i = 0; i < 40 && W.stateOf(key).status !== 'code'; i++) { seen.add(W.stateOf(key).step); await new Promise(r => setTimeout(r, 250)) }
    const s = W.stateOf(key)
    assert.equal(s.status, 'code'); assert.equal(s.code, 'K92B-X74Q'); assert.equal(s.phone, '251911234567')
    const said = linkLog(key).map(x => x.step).join(' | ')
    for (const w of ['Connect pressed for …567', 'Waiting for WhatsApp\'s page', 'Log in with phone number', 'Typing the number (…567)', 'Pressing Next', 'Waiting for WhatsApp\'s code', 'Type the code']) assert.ok(said.includes(w), `${w} — in: ${said}`)
    const off = W.cancelLink(key)
    assert.equal(off.status, 'off'); assert.equal(off.code, null)
  } finally { W.cancelLink(key); W._setClientForTests(key, null, { status: 'off' }); await b.close() }
})

test('the number box (frontend) and the PC read a number the same way', async () => {
  const F = await import('../../adal-keep-frontend/src/lib/waNumber.js')
  for (const v of ['+251 911 234 567', '0911234567', '251711234567', '00251911234567', '+966 55 123 4567', '911234567'])
    assert.equal(F.phoneDigits(v), phoneDigits(v), v)
  assert.equal(F.localPart('+251 0911 234 567'), '911234567')
  assert.equal(F.localPart('812345678'), '', 'a first digit other than 9 or 7 is not taken')
})
