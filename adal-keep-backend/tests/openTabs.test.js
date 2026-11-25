/** openTabs.test.js — the live view's tab strip: which tabs of the robot browser it lists and opens. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openTabs, pageOfTab, siteOfUrl } from '../src/services/openTabs.js'
const page = (id, url, name = '') => ({ url: () => url, isClosed: () => false, target: () => ({ _targetId: id }), evaluate: async () => name, __adalLabel: 'nuzla' })
const browser = (pages) => ({ targets: () => pages.map(p => ({ type: () => 'page', page: async () => p })) })

test('the robots\' sites only; a listed run\'s tab is the run\'s; a finished run\'s kept tab is listed', async () => {
  const b = browser([page('AAAAAAAA1', 'https://tawtheeq.musaned.com.sa/dashboard', 'adal-run-5'), page('AAAAAAAA2', 'https://wafid.com/en/search-slip/'), page('AAAAAAAA3', 'about:blank'), page('AAAAAAAA4', 'https://example.org/'), page('AAAAAAAA5', 'https://accounts.wahid.sa/auth', 'adal-run-7')])
  assert.deepEqual((await openTabs(b, [7])).map(t => [t.key, t.site]), [['tab-AAAAAAAA1', 'Musaned'], ['tab-AAAAAAAA2', 'Wafid']])
  assert.equal((await openTabs(b, [])).length, 3)
  assert.equal(siteOfUrl('https://evilmusaned.com.sa.example.org/'), '')
  // Only a tab of that list opens, by its own id.
  assert.equal(await pageOfTab('tab-AAAAAAAA4', b), null)
  assert.equal(await pageOfTab('tab-../../x', b), null)
  if (process.platform === 'linux') assert.ok(await pageOfTab('tab-AAAAAAAA2', b))
})
