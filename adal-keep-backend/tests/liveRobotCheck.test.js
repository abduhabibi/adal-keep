import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, ipForMac, subnetsOf, describeRun, findCaptcha, errorOf, verdict } from '../scripts/live-robot-check.mjs'

test('arguments: defaults, overrides and refusals', () => {
  const d = parseArgs([])
  assert.equal(d.profile, 749); assert.equal(d.workflow, 'musaned_check_chosen'); assert.equal(d.minutes, 8)
  assert.equal(parseArgs(['--ip', '192.168.1.9', '--profile', '12']).ip, '192.168.1.9')
  assert.throws(() => parseArgs(['--ip', '1.2.3; rm']))
  assert.throws(() => parseArgs(['--workflow', 'a b']))
  assert.throws(() => parseArgs(['--minutes', '30']))
  assert.throws(() => parseArgs(['--nope']))
})

test('Main is found by MAC in ip neigh and arp output', () => {
  const neigh = '192.168.1.1 dev wlan0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n192.168.1.23 dev wlan0 lladdr 00:11:7F:B7:D8:40 STALE\n'
  assert.equal(ipForMac(neigh), '192.168.1.23')
  assert.equal(ipForMac('? (10.0.0.7) at 00-11-7f-b7-d8-40 [ether] on wlan0'), '10.0.0.7')
  assert.equal(ipForMac(neigh.replace(/d8:40/i, '00:00')), '')
  const addr = '1: lo    inet 127.0.0.1/8 scope host lo\n3: wlan0    inet 192.168.1.50/24 brd 192.168.1.255 scope global wlan0\n5: docker0    inet 172.17.0.1/16 scope global docker0'
  assert.deepEqual(subnetsOf(addr), ['192.168.1'])
})

test('run output: new steps only, captcha, error and verdict', () => {
  const row = { status: 'paused', pause_reason: 'Captcha — solve it', log: [
    { ts: Date.parse('2026-11-23T08:00:01Z'), level: 'info', msg: 'Opening https://musaned.gov.sa/login' },
    { ts: Date.parse('2026-11-23T08:00:09Z'), level: 'error', msg: '⛔ reCAPTCHA shown at https://musaned.gov.sa/login' }] }
  const d = describeRun(row, 1)
  assert.equal(d.lines.length, 1); assert.equal(d.lines[0].time, '08:00:09'); assert.equal(d.total, 2)
  const c = findCaptcha(row)
  assert.ok(c.captcha); assert.equal(c.url, 'https://musaned.gov.sa/login')
  assert.match(errorOf(row), /reCAPTCHA/)
  assert.equal(verdict('paused', true).pass, false)
  assert.equal(verdict('done', false).pass, true)
  assert.equal(verdict('failed', false).pass, false)
  assert.equal(verdict('timeout', false).pass, false)
  assert.equal(findCaptcha({ log: [{ msg: 'all fine' }] }).captcha, false)
})
