import test from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns'
import { resolveHost } from '../src/utils/netFix.js'

const notFound = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }

test('the PC resolver answers: IPv4 first', async () => {
  const list = await resolveHost('a.example', {}, { sys: async () => [{ address: '::1', family: 6 }, { address: '1.2.3.4', family: 4 }], pub: notFound })
  assert.deepEqual(list.map(a => a.family), [4, 6])
})

test('the PC resolver fails (a router with broken DNS): public DNS answers', async () => {
  const list = await resolveHost('b.example', {}, { sys: notFound, pub: async () => [{ address: '149.154.166.110', family: 4 }] })
  assert.equal(list[0].address, '149.154.166.110')
})

test('both fail: the last good answer is used, else ENOTFOUND', async () => {
  await resolveHost('c.example', {}, { sys: async () => [{ address: '5.6.7.8', family: 4 }], pub: notFound })
  const again = await resolveHost('c.example', {}, { sys: notFound, pub: async () => [] })
  assert.equal(again[0].address, '5.6.7.8')
  await assert.rejects(resolveHost('d.example', {}, { sys: notFound, pub: async () => [] }), /ENOTFOUND/)
})

test('installed for every lookup (fetch, http, libraries)', async () => {
  assert.equal(dns.lookup.name, 'lookup')
  const addr = await new Promise((ok, no) => dns.lookup('localhost', (e, a) => e ? no(e) : ok(a)))
  assert.ok(addr)
})
