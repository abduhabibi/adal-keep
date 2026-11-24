/**
 * morningSignIn.test.js — the owner, 2026-11-24: "whenever I open Adal Keep create every one and tell me to sign
 * in into each". Which sign-in tabs are made ready (one after another, never a signed-in site, never Tasheer while
 * someone signs in to it), the card's lines (every account, Wafid on standby), and the sign-in tabs in the
 * sidebar's Browsers by site and account.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JEV_ENABLED = 'false'
process.env.ADAL_NO_BROWSER_START = '1'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'   // never the PC's own robot browser
const k = await import('../src/services/sessionKeeper.js')

test('one sign-in tab per site and account not signed in, in order, Tasheer left to whoever signs in to it', () => {
  const line = (key, extra = {}) => ({ key, account: { live: `site-${key}` }, signedIn: false, hasTab: false, ...extra })
  const todo = k.toPrepare([
    line('tasheer'), line('lmis'), line('musaned', { signedIn: true }), line('mofa'), line('insurance'),
    line('musaned', { account: { live: 'site-musaned-7' } }), line('lmis', { hasTab: true, account: { live: 'site-lmis-3' } }),
  ])
  assert.deepEqual(todo.map(l => l.account.live), ['site-musaned-7', 'site-insurance', 'site-mofa', 'site-lmis', 'site-tasheer'])
  assert.equal(k.toPrepare([line('tasheer', { heldByOther: true })]).length, 0)
})

test('the card lists every account of every site, and Wafid on standby', async () => {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  for (const t of ['musaned_accounts', 'lmis_accounts', 'visa_accounts', 'insurance_accounts', 'tasheer_accounts']) {
    await db.schema.createTable(t, c => { c.increments('id'); c.string('name'); c.string('username'); c.integer('is_default') })
  }
  await db.schema.createTable('automation_queue', c => { c.increments('id'); c.string('status') })
  await db('musaned_accounts').insert([{ id: 1, name: 'Nuzla', is_default: 1 }, { id: 7, name: 'Second', is_default: 0 }])
  await db('tasheer_accounts').insert([{ id: 1, name: 'A', is_default: 1 }, { id: 2, name: 'B', is_default: 0 }])
  // Not started: the 10-minute look would open a browser (none in this test).
  process.env.ADAL_MORNING_SIGNIN = '0'
  await k.prepareSignIns(db)
  const sites = await k.sessionsNow()
  const mus = sites.find(s => s.key === 'musaned')
  assert.deepEqual(mus.accounts.map(a => [a.name, a.live, a.state]), [['Nuzla', 'site-musaned', 'not-open'], ['Second', 'site-musaned-7', 'not-open']])
  assert.equal(sites.find(s => s.key === 'tasheer').accounts.length, 1, 'Tasheer: one sign-in for the agency')
  assert.ok(sites.find(s => s.key === 'lmis').noAccount)
  assert.ok(sites.find(s => s.key === 'insurance'), 'insurance is on the card')
  assert.ok(sites.find(s => s.key === 'wafid')?.standby)
  assert.match(mus.ask, /not a robot/)
  await db.destroy()
})

test('sign-in tabs show in the sidebar by site and account, not twice when a run works in one', async () => {
  const { listBrowsers } = await import('../src/services/robotBrowsers.js')
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.string('workflow_id'); t.string('status'); t.text('context'); t.integer('profile_id'); t.string('pause_reason'); t.string('started_at'); t.string('updated_at') })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name') })
  await db('automation_queue').insert({ id: 5, workflow_id: 'musaned_add_candidate', status: 'running', updated_at: new Date().toISOString() })
  const list = await listBrowsers(db, {
    devices: [], waiting: [], hasTab: (id) => id === 5, hostname: 'this PC',
    signIns: [
      { key: 'site-musaned', run_id: 5, site: 'Musaned', girl: 'Nuzla', status: 'Signed in' },
      { key: 'site-lmis', site: 'LMIS', girl: 'Main', status: 'Sign in', needs_you: true, task: 'Sign in to LMIS (Main)' },
      { key: 'site-wafid', site: 'Wafid', status: 'Ready (no sign-in)' },
    ],
  })
  assert.deepEqual(list.map(b => b.key), ['5', 'site-lmis', 'site-wafid'])
  const lmis = list.find(b => b.key === 'site-lmis')
  assert.equal(lmis.site, 'LMIS'); assert.equal(lmis.girl, 'Main'); assert.ok(lmis.needs_you); assert.equal(lmis.pc, 'this PC')
  await db.destroy()
})

test('after a restart the account\'s own sign-in tab is found again by its label (Musaned\'s on wahid.sa too), never a sign-out page', () => {
  const mus = k.SITES.find(s => s.key === 'musaned'), visa = k.SITES.find(s => s.key === 'mofa')
  assert.ok(k.isSignInTabOf(mus, 'Zad', 'https://accounts.wahid.sa/auth/realms/wahid/protocol/openid-connect/auth?x', '[Zad] Sign in to Musaned'))
  assert.ok(!k.isSignInTabOf(mus, 'Zad', 'https://accounts.wahid.sa/auth/realms/wahid/protocol/openid-connect/logout', '[Zad] accounts.wahid.sa'))
  assert.ok(!k.isSignInTabOf(mus, 'Zad', 'https://accounts.wahid.sa/auth', '[nuzla] Sign in to Musaned'), 'another account\'s tab')
  assert.ok(k.isSignInTabOf(visa, 'Nuzla', 'https://visa.mofa.gov.sa/Account/Login/enjazcompany', '[Nuzla] Visa platform'))
  assert.ok(!k.isSignInTabOf(visa, 'Nuzla', 'https://wafid.com/en/', '[Nuzla] Wafid'))
})

test('lost tabs closed only when on a portal\'s sign-out page', () => {
  assert.ok(k.lostSignOut('https://accounts.wahid.sa/auth/realms/wahid/protocol/openid-connect/logout?client_id=etawtheeq-fe'))
  assert.ok(!k.lostSignOut('chrome-error://chromewebdata/'))
  assert.ok(!k.lostSignOut('https://tawtheeq.musaned.com.sa/hr-pool/candidates/add'))
  assert.ok(!k.lostSignOut('https://accounts.wahid.sa/auth/realms/wahid/protocol/openid-connect/auth?x'))
  assert.ok(!k.lostSignOut('https://example.com/logout'))
})

test('a waiting sign-in tab is paused (its scripts stop) and runs again when woken', { skip: !['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/brave.com/brave/brave'].some(f => fs.existsSync(f)) && 'no browser', timeout: 60000 }, async () => {
  const puppeteer = (await import('puppeteer-core')).default
  const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/brave.com/brave/brave'].find(f => fs.existsSync(f))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-freeze-'))
  const b = await puppeteer.launch({ executablePath: exe, headless: true, userDataDir: dir, args: ['--no-first-run'] })
  try {
    const p = await b.newPage()
    await p.setContent('<script>window.n = 0; setInterval(() => window.n++, 20)</script>')
    await new Promise(r => setTimeout(r, 300))
    const before = await p.evaluate(() => window.n)
    await k.freezeTab(p)
    assert.ok(p.__adalFrozen)
    await new Promise(r => setTimeout(r, 1000))      // 50 ticks if it were running
    await k.wakeTab(p)
    const woke = await p.evaluate(() => window.n)
    assert.ok(woke - before < 8, `paused while it waited (${woke - before} ticks in 1 s)`)
    await new Promise(r => setTimeout(r, 300))
    assert.ok(await p.evaluate(() => window.n) > woke, 'runs again after waking')
    assert.ok(!p.__adalFrozen)
  } finally { await b.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
