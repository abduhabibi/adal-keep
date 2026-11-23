import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync, spawn } from 'child_process'
import { fileURLToPath } from 'url'

// Branch links in a real Postgres (a throw-away cluster in a temp folder,
// never Supabase): adal-admin/supabase/branch-links.sql on a stand-in for
// Supabase's auth (auth.users, auth.uid() from the JWT setting) and the few
// tables it needs. Skipped on a PC without Postgres (initdb).
const SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'adal-admin', 'supabase', 'branch-links.sql')

const bindir = (() => {
  const r = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' })
  const dirs = [r.status === 0 ? r.stdout.trim() : '', ...(fs.existsSync('/usr/lib/postgresql') ? fs.readdirSync('/usr/lib/postgresql').sort().reverse().map(v => `/usr/lib/postgresql/${v}/bin`) : [])]
  return dirs.find(d => d && fs.existsSync(path.join(d, 'initdb')) && fs.existsSync(path.join(d, 'postgres'))) || null
})()

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c'
const PHONE = '00000000-0000-0000-0000-0000000000f0'

const STUB = `
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
create schema extensions;
create extension pgcrypto schema extensions;
create table public.agencies (id uuid primary key references auth.users, name text not null, pc_number text, banned boolean not null default false, is_admin boolean not null default false, last_seen timestamptz not null default now());
create table public.keep_devices (user_id uuid primary key references auth.users, agency_id uuid not null references auth.users, name text, revoked boolean not null default false);
create table public.keep_profiles (agency_id uuid not null references auth.users, id bigint not null, data jsonb not null, updated_at timestamptz not null default now(), deleted boolean not null default false, primary key (agency_id, id));
create table public.keep_pairing (pc_number text primary key, agency_id uuid not null references auth.users, pass_hash text, open boolean not null default false);
create function public.keep_set_phone_password(p_pc text, p_password text) returns void language sql as $$ select 1 $$;
create function public.keep_join(p_pc text, p_password text, p_name text) returns uuid language sql as $$ select null::uuid $$;
insert into auth.users values ('${A}'), ('${B}'), ('${C}'), ('${PHONE}');
insert into public.agencies (id, name) values ('${A}', 'Adal Nuzla Addis'), ('${B}', 'Adal Nuzla Adama'), ('${C}', 'Other Agency');
insert into public.keep_devices values ('${PHONE}', '${A}', 'Phone', false);
insert into public.keep_pairing values ('123456', '${A}', 'old-hash', false);
insert into public.keep_profiles values
  ('${B}', 1, '{"full_name":"Almaz Test","passport_number":"EP111","stage":"medical","status":"active","nationality":"Ethiopian","photo":"secret.jpg"}', now(), false),
  ('${B}', 2, '{"full_name":"Hana Test","passport_number":"EP222","stage":"visa"}', now(), false),
  ('${C}', 9, '{"full_name":"Not Yours","passport_number":"EP999"}', now(), false);
`

let dir, port, pg
const psql = (sql, { as = null } = {}) => {
  const pre = as ? `set role authenticated; select set_config('request.jwt.claim.sub', '${as}', false) \\g /dev/null\n` : ''
  const r = spawnSync(path.join(bindir, 'psql'), ['-h', dir, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: pre + sql, encoding: 'utf8', timeout: 30000 })
  if (r.status !== 0) { const e = new Error((r.stderr || '').replace(/^psql:[^:]*:\d+: /gm, '').trim()); e.sql = sql; throw e }
  return r.stdout.trim()
}
const as = (who, sql) => psql(sql, { as: who })
const one = (who, sql) => as(who, sql).split('\n').pop()

test('branch links in Postgres', { skip: !bindir && 'no Postgres on this PC' }, async (t) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-branch-pg-'))
  port = 20000 + Math.floor(Math.random() * 20000)
  const init = spawnSync(path.join(bindir, 'initdb'), ['-D', path.join(dir, 'data'), '-U', 'postgres', '-A', 'trust', '--no-sync'], { encoding: 'utf8', timeout: 60000 })
  assert.equal(init.status, 0, init.stderr)
  pg = spawn(path.join(bindir, 'postgres'), ['-D', path.join(dir, 'data'), '-p', String(port), '-k', dir, '-c', 'listen_addresses=', '-c', 'fsync=off'], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    if (spawnSync(path.join(bindir, 'pg_isready'), ['-h', dir, '-p', String(port)]).status === 0) break
    await new Promise(r => setTimeout(r, 100))
  }
  t.after(() => { try { pg.kill('SIGINT') } catch {} ; setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500) })

  psql(STUB)
  psql(fs.readFileSync(SQL, 'utf8'))
  psql(fs.readFileSync(SQL, 'utf8'))   // safe to run again

  await t.test('the phone password is gone, the PC numbers stay', () => {
    assert.equal(psql(`select count(*) from pg_proc where proname in ('keep_set_phone_password', 'keep_join')`), '0')
    assert.equal(psql(`select coalesce(pass_hash, 'none') || ' ' || pc_number from keep_pairing`), 'none 123456')
  })

  await t.test('search shows name and city only, not yourself', () => {
    as(B, `select keep_set_city('Adama')`)
    const rows = as(A, `select row_to_json(s) from keep_branch_search('nuzla') s`).split('\n').map(JSON.parse)
    assert.deepEqual(rows, [{ id: B, name: 'Adal Nuzla Adama', city: 'Adama', linked: false }])
    assert.equal(as(A, `select count(*) from keep_branch_search('a')`), '0')   // two letters at least
    assert.throws(() => as(PHONE, `select * from keep_branch_search('nuzla')`), /phones cannot/)
  })

  let rid
  await t.test('wrong code, then the right one links both ways', () => {
    rid = one(A, `select keep_branch_ask('${B}')`)
    assert.equal(one(A, `select keep_branch_verify('${rid}', '000000')`), 'not_yet')   // B has not said yes
    const inbox = as(B, `select name || '|' || status from keep_branch_inbox()`)
    assert.equal(inbox, 'Adal Nuzla Addis|pending')
    assert.equal(as(C, `select count(*) from keep_branch_inbox()`), '0')
    assert.throws(() => as(C, `select keep_branch_confirm('${rid}')`), /gone/)    // not C's to answer
    assert.throws(() => as(A, `select keep_branch_confirm('${rid}')`), /gone/)    // nor the sender's
    const code = one(B, `select keep_branch_confirm('${rid}')`)
    assert.match(code, /^\d{6}$/)
    // The code is never readable: no policy on the requests table.
    assert.throws(() => as(A, `select code_hash from keep_branch_requests`), /permission denied/)
    const wrong = code === '123456' ? '654321' : '123456'
    assert.equal(one(A, `select keep_branch_verify('${rid}', '${wrong}')`), 'wrong')
    assert.equal(psql(`select tries from keep_branch_requests where id = '${rid}'`), '1')   // the wrong try is counted
    assert.equal(one(C, `select keep_branch_verify('${rid}', '${code}')`), 'gone')         // only the sender types it
    assert.equal(one(A, `select keep_branch_verify('${rid}', '${code}')`), 'linked')
    assert.equal(as(A, `select name || '|' || i_share || '|' || they_share from keep_branch_list()`), 'Adal Nuzla Adama|true|true')
    assert.equal(as(B, `select name from keep_branch_list()`), 'Adal Nuzla Addis')
  })

  await t.test('a used code does not work again', () => {
    const code = '000000'
    assert.equal(one(A, `select keep_branch_verify('${rid}', '${code}')`), 'used')
    assert.throws(() => as(B, `select keep_branch_confirm('${rid}')`), /gone/)
  })

  await t.test('only the two agencies see the link and the profiles', () => {
    assert.equal(as(A, `select count(*) from keep_branch_links`), '1')
    assert.equal(as(B, `select count(*) from keep_branch_links`), '1')
    assert.equal(as(C, `select count(*) from keep_branch_links`), '0')
    const p = as(A, `select row_to_json(p) from keep_branch_profiles('${B}') p`).split('\n').map(JSON.parse)
    assert.deepEqual(p.map(x => [x.name, x.passport, x.stage]), [['Almaz Test', 'EP111', 'medical'], ['Hana Test', 'EP222', 'visa']])
    assert.ok(!JSON.stringify(p).includes('secret.jpg'))   // the summary, not the whole row
    assert.throws(() => as(A, `select * from keep_branch_profiles('${C}')`), /Not linked/)
    assert.throws(() => as(C, `select * from keep_branch_profiles('${B}')`), /Not linked/)
    as(B, `select keep_branch_share('${A}', false)`)
    assert.equal(as(A, `select count(*) from keep_branch_profiles('${B}')`), '0')
    assert.equal(as(A, `select they_share from keep_branch_list()`), 'f')
    as(B, `select keep_branch_share('${A}', true)`)
  })

  await t.test('unlink ends it for both', () => {
    as(B, `select keep_branch_unlink('${A}')`)
    assert.equal(as(A, `select count(*) from keep_branch_list()`), '0')
    assert.equal(as(B, `select count(*) from keep_branch_links`), '0')
    assert.throws(() => as(A, `select * from keep_branch_profiles('${B}')`), /Not linked/)
  })

  await t.test('an expired code does not work', () => {
    const id = one(A, `select keep_branch_ask('${B}')`)
    const code = one(B, `select keep_branch_confirm('${id}')`)
    psql(`update keep_branch_requests set code_until = now() - interval '1 second' where id = '${id}'`)   // 10 minutes later
    assert.equal(one(A, `select keep_branch_verify('${id}', '${code}')`), 'expired')
    assert.equal(one(A, `select keep_branch_verify('${id}', '${code}')`), 'gone')
    assert.equal(as(A, `select count(*) from keep_branch_list()`), '0')
  })

  await t.test('five wrong codes end the request', () => {
    const id = one(A, `select keep_branch_ask('${B}')`)
    const code = one(B, `select keep_branch_confirm('${id}')`)
    const wrong = code === '111111' ? '222222' : '111111'
    const answers = [1, 2, 3, 4, 5].map(() => one(A, `select keep_branch_verify('${id}', '${wrong}')`))
    assert.deepEqual(answers, ['wrong', 'wrong', 'wrong', 'wrong', 'too_many'])
    assert.equal(one(A, `select keep_branch_verify('${id}', '${code}')`), 'gone')   // even the right one, now
  })

  await t.test('a new code replaces the old one; codes and Connects are limited', () => {
    const id = one(A, `select keep_branch_ask('${B}')`)
    const first = one(B, `select keep_branch_confirm('${id}')`)
    let second = one(B, `select keep_branch_confirm('${id}')`)
    for (let i = 0; second === first && i < 3; i++) second = one(B, `select keep_branch_confirm('${id}')`)
    if (second !== first) assert.equal(one(A, `select keep_branch_verify('${id}', '${first}')`), 'wrong')
    for (let i = psql(`select codes_made from keep_branch_requests where id = '${id}'`); i < 5; i++) one(B, `select keep_branch_confirm('${id}')`)
    assert.throws(() => as(B, `select keep_branch_confirm('${id}')`), /Too many codes/)
    psql(`delete from keep_branch_requests`)
    for (let i = 0; i < 10; i++) one(A, `select keep_branch_ask('${C}')`)
    assert.throws(() => as(A, `select keep_branch_ask('${C}')`), /Too many Connects/)
    // A new Connect to the same agency cancels the older open one.
    assert.equal(psql(`select count(*) from keep_branch_requests where status = 'pending'`), '1')
  })

  await t.test('No answers: the request ends', () => {
    psql(`delete from keep_branch_requests`)
    const id = one(C, `select keep_branch_ask('${B}')`)
    as(B, `select keep_branch_deny('${id}')`)
    assert.equal(as(B, `select count(*) from keep_branch_inbox()`), '0')
    assert.equal(as(C, `select status from keep_branch_outbox()`), 'denied')
    assert.throws(() => as(A, `select keep_branch_ask('${A}')`), /another agency/)
  })
})
