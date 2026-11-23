// Data protection: the Supabase SQL (adal-admin/supabase/*.sql) is checked as text on every test run —
// every table has row level security and agency-scoped rules, every bucket is private and its rules name
// an agency folder or a membership. A new table or bucket that forgets this fails here.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'adal-admin', 'supabase')
const sql = // (run order: rls-hardening.sql is run last, so its rules replace the older ones)
fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort((a, b) => (a === 'rls-hardening.sql') - (b === 'rls-hardening.sql') || a.localeCompare(b)).map(f => ({ f, s: fs.readFileSync(path.join(DIR, f), 'utf8').replace(/--.*$/gm, '') }))
const all = sql.map(x => x.s).join('\n')

const tables = [...new Set([...all.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)].map(m => m[1]))]
const rlsOn = new Set([...all.matchAll(/alter table (?:if exists )?public\.(\w+)\s+enable row level security/gi)].map(m => m[1]))
const policies = [...all.matchAll(/create policy (\w+) on ([\w.]+)\s+(?:as \w+\s+)?for (\w+)([\s\S]*?);/gi)].map(m => ({ name: m[1], on: m[2].replace('public.', ''), cmd: m[3].toLowerCase(), body: m[4] }))
// Rules written in a loop (format('create policy %I on public.%I ...')) are read from the loop body.
const looped = [...all.matchAll(/format\('create policy %I on public\.%I for (\w+) using \(([^']*)\)/gi)].map(m => ({ cmd: m[1].toLowerCase(), body: m[2] }))

test('there are tables to check', () => assert.ok(tables.length >= 20, `found ${tables.length}`))

test('every table in public has row level security on', () => {
  const missing = tables.filter(t => !rlsOn.has(t) && !/(execute format|enable row level security)/.test(all.match(new RegExp(`${t}[\\s\\S]{0,40}`))?.[0] || ''))
  // keep_* tables written in a loop are enabled by name above; anything left is a real gap.
  assert.deepEqual(missing.filter(t => !rlsOn.has(t)), [])
})

test('no rule is open to everyone (using true / anon)', () => {
  for (const p of policies) {
    assert.ok(!/\b(using|with check)\s*\(\s*true\s*\)/i.test(p.body), `${p.name} is open to everyone`)
    assert.ok(!/\bto\s+anon\b/i.test(p.body), `${p.name} is open to anon`)
  }
  assert.ok(!/grant\s+(select|insert|update|delete|all)[^;]*\bto\s+anon\b/i.test(all), 'a table is granted to anon')
})

test('every table rule names the agency or a membership', () => {
  const scoped = /(keep_agency\(\)|auth\.uid\(\)|is_member\(|is_admin\(\)|can_get_updates\(\)|can_manage\()/i
  for (const p of policies.filter(p => !p.on.startsWith('storage'))) assert.match(p.body, scoped, `${p.name} on ${p.on} is not scoped to an agency`)
  for (const p of looped) assert.match(p.body, scoped)
})

test('every bucket is private', () => {
  const buckets = [...all.matchAll(/insert into storage\.buckets\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/gi)]
  assert.ok(buckets.length >= 4, 'buckets: keep, chat, agency-config, adal-updates')
  for (const b of buckets) assert.match(b[2], /,\s*false\s*$/i, `bucket ${b[2]} is public`)
})

test('every bucket rule names the bucket and an agency folder, a membership or an update right', () => {
  // (a rule made again later replaces the earlier one of the same name)
  const objs = [...new Map(policies.filter(p => p.on === 'storage.objects').map(p => [p.name, p])).values()]
  assert.ok(objs.length >= 8)
  for (const p of objs) {
    assert.match(p.body, /bucket_id\s*=\s*'[\w-]+'/, `${p.name} names no bucket`)
    assert.match(p.body, /(storage\.foldername\(name\)\)\[1\]\s*=|is_member\(|can_get_updates\(\))/, `${p.name} is not scoped`)
  }
})

test('the chat bucket is not readable by every signed-in agency (the gap that was fixed)', () => {
  const reads = policies.filter(p => p.name === 'chat_read')
  const last = reads[reads.length - 1]
  assert.match(last.body, /is_member\(/)
  assert.match(last.body, /foldername/)
})

test('the audit table cannot be changed after the fact', () => {
  const a = policies.filter(p => p.on === 'keep_audit')
  assert.deepEqual(a.map(p => p.cmd).sort(), ['insert', 'select'])
})
