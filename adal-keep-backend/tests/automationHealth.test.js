import test from 'node:test'
import assert from 'node:assert/strict'
import { portalOf, dotOf, portalHealth, healthBoard } from '../src/services/automationHealth.js'

const NOW = Date.parse('2026-11-19T12:00:00Z')
const ago = (h) => new Date(NOW - h * 3600_000).toISOString()

test('each run belongs to its portal', () => {
  assert.equal(portalOf('musaned_add_candidate'), 'musaned')
  assert.equal(portalOf('mofa_visa'), 'enjaz')
  assert.equal(portalOf('police_certificate'), 'lmis')
  assert.equal(portalOf('lmis_contract'), 'lmis')
  assert.equal(portalOf('tasheer_schedule'), 'tasheer')
  assert.equal(portalOf('wafid_book'), 'wafid')
  assert.equal(portalOf('insurance_certificate'), null)
})

test('the dot: green when the newest worked, amber after a recent success, red when it keeps failing', () => {
  assert.equal(dotOf({ ok: 0, fail: 0, now: NOW }), 'grey')
  assert.equal(dotOf({ ok: NOW - 1000, fail: NOW - 5000, now: NOW }), 'green')
  assert.equal(dotOf({ ok: NOW - 3600_000, fail: NOW - 1000, now: NOW }), 'amber')
  assert.equal(dotOf({ ok: NOW - 10 * 86400_000, fail: NOW - 1000, now: NOW }), 'red')
  assert.equal(dotOf({ ok: 0, fail: NOW - 1000, now: NOW }), 'red')
  // A daily job that has not worked for a while.
  assert.equal(dotOf({ ok: NOW - 3 * 86400_000, fail: 0, now: NOW, staleAfter: 2 * 86400_000 }), 'amber')
  assert.equal(dotOf({ ok: NOW - 5 * 86400_000, fail: 0, now: NOW, staleAfter: 2 * 86400_000 }), 'red')
})

test('portals: the newest success and failure, with the failure in plain words', () => {
  const h = portalHealth([
    { workflow_id: 'musaned_add_candidate', status: 'done', finished_at: ago(5) },
    { workflow_id: 'musaned_delete', status: 'failed', finished_at: ago(1), pause_reason: 'Could not reach tawtheeq.musaned.com.sa (after 1 attempts)' },
    { workflow_id: 'musaned_add_candidate', status: 'failed', finished_at: ago(30), pause_reason: 'old' },
    { workflow_id: 'wafid_book', status: 'done', finished_at: ago(2) },
    { workflow_id: 'mofa_visa', status: 'cancelled', finished_at: ago(1) },
  ], NOW)
  assert.equal(h.musaned.last_ok, ago(5))
  assert.equal(h.musaned.last_fail, ago(1))
  assert.equal(h.musaned.why, 'the site was not available')
  assert.equal(h.musaned.dot, 'amber')
  assert.equal(h.wafid.dot, 'green')
  assert.equal(h.wafid.why, null)
  assert.equal(h.enjaz, undefined)   // a cancelled run is neither
})

test('the board lists every item, the background jobs from their own state', () => {
  const b = healthBoard({
    now: NOW,
    runs: [{ workflow_id: 'police_certificate', status: 'failed', finished_at: ago(1), pause_reason: 'Worker card not found' }],
    wa: { used: true, status: 'off', error: 'The WhatsApp tab was closed — press Connect again', last_sent: ago(3) },
    backup: { enabled: true, last_ok: ago(20), last_fail: 'Telegram 502', last_fail_at: ago(40) },
    cloud: { on: false },
  })
  assert.deepEqual(b.items.map(i => i.key), ['musaned', 'enjaz', 'lmis', 'tasheer', 'wafid', 'whatsapp', 'backup', 'online'])
  const by = Object.fromEntries(b.items.map(i => [i.key, i]))
  assert.equal(by.lmis.dot, 'red')
  assert.equal(by.lmis.why, 'she was not found on the site')
  assert.equal(by.musaned.dot, 'grey')
  assert.equal(by.whatsapp.dot, 'red')
  assert.match(by.whatsapp.note, /tab was closed/)
  assert.equal(by.backup.dot, 'green')
  assert.equal(by.backup.why, 'Telegram 502')
  assert.equal(by.online.dot, 'grey')
  assert.equal(by.online.note, 'not turned on')
})
