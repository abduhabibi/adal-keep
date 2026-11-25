/** openTabs.test.js — the live view's tab strip: which tabs of the robot browser it lists and opens. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openTabs, pageOfTab, siteOfUrl, tabGone } from '../src/services/openTabs.js'
const page = (id, url, name = '') => ({ url: () => url, isClosed: () => false, target: () => ({ _targetId: id }), evaluate: async () => name, __adalLabel: 'nuzla' })
const browser = (pages) => { const b = { targets: () => pages.map(p => ({ type: () => 'page', url: p.url, _targetId: p.target()._targetId, page: p.slow ? () => new Promise(() => {}) : async () => p })) }; return b }

test('the robots\' sites only; a listed run\'s tab is the run\'s; a finished run\'s kept tab is listed', async () => {
  const b = browser([page('AAAAAAAA1', 'https://tawtheeq.musaned.com.sa/dashboard', 'adal-run-5'), page('AAAAAAAA2', 'https://wafid.com/en/search-slip/'), page('AAAAAAAA3', 'about:blank'), page('AAAAAAAA4', 'https://example.org/'), page('AAAAAAAA5', 'https://accounts.wahid.sa/auth', 'adal-run-7')])
  assert.deepEqual((await openTabs(b, [7])).map(t => [t.key, t.site]), [['tab-AAAAAAAA2', 'Wafid']], 'the run is the one Musaned')
  assert.deepEqual((await openTabs(b, [])).map(t => t.key), ['tab-AAAAAAAA1', 'tab-AAAAAAAA2'], 'one Musaned: the signed-in one, not its sign-in page')
  assert.equal(siteOfUrl('https://evilmusaned.com.sa.example.org/'), '')
  // Only a tab of that list opens, by its own id.
  assert.equal(await pageOfTab('tab-AAAAAAAA4', b), null)
  assert.equal(await pageOfTab('tab-../../x', b), null)
  if (process.platform === 'linux') assert.ok(await pageOfTab('tab-AAAAAAAA2', b))
})

test('one Musaned an account: two accounts are two; the best of three; a slow tab is not gone', async () => {
  const A = { a: 1 }, B = { b: 1 }
  const in_ = (p, c) => ({ ...p, browserContext: () => c })
  const b = browser([in_(page('AAAAAAAA1', 'https://accounts.wahid.sa/auth'), A), in_(page('AAAAAAAA2', 'https://tawtheeq.musaned.com.sa/hr-pool'), A), in_(page('AAAAAAAA3', 'https://tawtheeq.musaned.com.sa/login'), A), in_(page('AAAAAAAA4', 'https://tawtheeq.musaned.com.sa/dashboard'), B)])
  assert.deepEqual((await openTabs(b, [])).map(t => t.key), ['tab-AAAAAAAA2', 'tab-AAAAAAAA4'])
  // Here but slow: not gone, whatever one look says. Really closed: after 4 s.
  const slow = browser([{ ...page('BBBBBBBB1', 'https://wafid.com/'), slow: true }])
  assert.equal(await tabGone('tab-BBBBBBBB1', slow), false)
  assert.equal(await tabGone('tab-BBBBBBBB2', slow, 1000), false, 'one miss is not gone')
  assert.equal(await tabGone('tab-BBBBBBBB2', slow, 3000), false)
  assert.equal(await tabGone('tab-BBBBBBBB2', slow, 5500), true)
})
