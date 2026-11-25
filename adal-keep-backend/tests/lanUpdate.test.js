// The owner, 2026-11-25: Main is updated, its Companions take the signed release from it over the LAN.
// Here: the builder (it only builds, no network), and what Main hands out (only what Adal signed).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import express from 'express'
import { spawnSync, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const BACK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-lanrel-'))
process.env.ADAL_LAN_RELEASE_DIR = path.join(tmp, 'kept')
const { _setVerifyKeyForTests, verifyManifest } = await import('../src/services/updateChannel.js')
const L = await import('../src/services/lanRelease.js')
const Lan = await import('../src/services/lanServe.js')
const key = crypto.generateKeyPairSync('ed25519')
const pem = path.join(tmp, 'test-key.pem')
fs.writeFileSync(pem, key.privateKey.export({ type: 'pkcs8', format: 'pem' }))
_setVerifyKeyForTests(key.publicKey.export({ type: 'spki', format: 'pem' }))
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

const SRC = path.join(BACK, 'scripts/build-lan-release.mjs')
test('the builder cannot upload: no key of Supabase, no network call, none of publish-update', () => {
  const s = fs.readFileSync(SRC, 'utf8')
  const imports = [...s.matchAll(/from '([^']+)'/g)].map(m => m[1])
  assert.deepEqual(imports.filter(i => !/^(fs|os|path|crypto|zlib|child_process|url|\.\.\/src\/services\/(updateChannel|rollback|bsdiff|whatsNew)\.js)$/.test(i)), [])
  assert.ok(!/dotenv|SERVICE_KEY|https?:\/\/|import\(/.test(s))
  assert.match(s, /unshare/)
})

// A small repository of its own with the builder in it.
const repo = path.join(tmp, 'repo'), B = path.join(repo, 'adal-keep-backend')
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' })
const write = (p, c) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), c) }
const fill = 'const line = "of a long file that does not change";\n'.repeat(400)
const build = (...args) => spawnSync(process.execPath, [path.join(B, 'scripts/build-lan-release.mjs'), '--no-programs', '--dist', path.join(repo, 'dist'), '--online', path.join(repo, 'www'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: tmp, ADAL_LAN_BUILD_FENCED: process.env.ADAL_TEST_FENCE ? '' : '1' } })
let one, two
test('a dry run signs nothing; a signed one is a release as ever; the next one carries a patch per file', () => {
  for (const f of ['updateChannel.js', 'rollback.js', 'bsdiff.js', 'whatsNew.js']) write(`adal-keep-backend/src/services/${f}`, fs.readFileSync(path.join(BACK, 'src/services', f)))
  write('adal-keep-backend/scripts/build-lan-release.mjs', fs.readFileSync(SRC))
  write('adal-keep-backend/package.json', '{"type":"module"}'); write('adal-keep-backend/package-lock.json', '{"packages":{}}')
  write('adal-keep-backend/server.js', 'import "./main.js"\n'); write('adal-keep-backend/main.js', fill + 'export const v = 1\n')
  write('adal-keep-backend/robots/adal-robots.mjs', 'robots'); write('adal-keep-backend/data/secret.json', 'never'); write('adal-keep-backend/.env', 'KEY=never')
  write('adal-keep-backend/src/migrations/001_a.js', 'm'); write('dist/index.html', '<html>'); write('dist/assets/index-AAAAAAAA.js', fill + '1'); write('www/index.html', 'own pages')
  git('init', '-q'); git('add', '-f', '-A'); git('commit', '-qm', 'one')
  const d = build('--out', path.join(tmp, 'rel/dry'))
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /nothing signed/)
  assert.ok(!fs.existsSync(path.join(tmp, 'rel/dry/current.json')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'rel/dry/UNSIGNED.json'))).signature, undefined)
  const s = build('--sign', '--key', pem, '--out', path.join(tmp, 'rel/one'))
  assert.equal(s.status, 0, s.stderr)
  one = JSON.parse(fs.readFileSync(path.join(tmp, 'rel/one/current.json')))
  assert.ok(verifyManifest(one.manifest, one.signature))
  assert.ok(one.manifest.app_files['adal-keep-backend/robots/adal-robots.mjs'])
  assert.deepEqual(Object.keys(one.manifest.app_files).filter(f => /data|\.env/.test(f)), [])
  // One line in main.js; a page's chunk with another name and one letter more.
  write('adal-keep-backend/main.js', fill + 'export const v = 2\n')
  fs.rmSync(path.join(repo, 'dist/assets/index-AAAAAAAA.js')); write('dist/assets/index-BBBBBBBB.js', fill + '12')
  git('add', '-f', '-A'); git('commit', '-qm', 'two')
  const s2 = build('--sign', '--key', pem, '--out', path.join(tmp, 'rel/two'))
  assert.equal(s2.status, 0, s2.stderr)
  two = JSON.parse(fs.readFileSync(path.join(tmp, 'rel/two/current.json')))
  const p = two.manifest.file_patches
  assert.equal(Object.keys(p).length, 2, JSON.stringify(p))
  for (const x of Object.values(p)) assert.ok(x.size < 400 && fs.existsSync(path.join(tmp, 'rel/two/files', x.sha256)), `${x.size}`)
  assert.equal(two.manifest.rollback.manifest.sha, one.manifest.sha, 'the way back to the release before, signed')
  assert.ok(L.isNewer(two.manifest, one.manifest))
})

test('Main hands out the release it runs, to its own Companions, and only files it names that are as signed', async (t) => {
  const root = path.join(tmp, 'install')
  for (const [rel, dest] of [['adal-keep-backend', 'backend'], ['dist', 'adal-keep-frontend/dist']]) fs.cpSync(path.join(repo, rel), path.join(root, dest), { recursive: true })
  const env = await L.importRelease(path.join(tmp, 'rel/two'))
  await L.recordInstalled(env)
  for (const x of L.extrasOf(env.manifest)) assert.ok(L.piecePath(x.sha256), 'the small patches are kept on Main')
  assert.equal(Lan.releaseHere({ root }), null, 'another version runs here (hand-placed files): nothing is handed on')
  fs.writeFileSync(path.join(root, '.adal-version.json'), JSON.stringify({ sha: env.manifest.sha }))
  const here = { root, backend: path.join(root, 'backend'), env: Lan.releaseHere({ root }) }
  assert.equal(here.env.manifest.sha, two.manifest.sha)
  const main = sha(fs.readFileSync(path.join(root, 'backend/main.js')))
  assert.equal((await Lan.fileHere(main, here)).file, path.join(root, 'backend/main.js'))
  assert.ok(await Lan.fileHere(Object.values(two.manifest.file_patches)[0].sha256, here))
  // Not in the release: the keys, the data, anything else on this PC.
  for (const f of ['backend/.env', 'backend/data/secret.json']) assert.equal(await Lan.fileHere(sha(fs.readFileSync(path.join(root, f))), here), null, f)
  // Changed by hand on Main: not sent.
  fs.appendFileSync(path.join(root, 'backend/main.js'), '// by hand')
  assert.equal(await Lan.fileHere(main, here), null)
  assert.equal(await Lan.fileHere(sha(fs.readFileSync(path.join(root, 'backend/main.js'))), here), null)
  process.env.ADAL_LAN_UPDATES = '0'
  try { assert.equal(Lan.releaseHere({ root }), null) } finally { delete process.env.ADAL_LAN_UPDATES }
  for (const bad of ['../x', 'adal-keep-backend/../x', '/etc/x', 'C:/x', 'a\\b', 'adal-keep-backend/data/x', 'adal-keep-backend/.env']) assert.equal(Lan.safeRel(bad), false, bad)

  await t.test('the routes: only an approved Companion on the office network; they answer gzip and 304', async () => {
    const { default: router } = await import('../src/routes/lanUpdate.js')
    const app = express()
    app.use((req, _res, next) => { if (req.headers['x-test-pc']) req.pcAccess = { id: 'a' }; next() })
    app.use('/api', router)
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    try {
      const get = (p, h = {}) => fetch(`http://127.0.0.1:${srv.address().port}/api/companion/lan/${p}`, { headers: h })
      assert.equal((await get('latest')).status, 403)
      assert.equal((await get('latest', { 'x-test-pc': '1', 'x-adal-cloud': '1' })).status, 403, 'never through the online link')
      assert.ok([200, 404].includes((await get('latest', { 'x-test-pc': '1' })).status))
      assert.equal((await get(`file/${'0'.repeat(64)}`, { 'x-test-pc': '1' })).status, 404)
      assert.equal((await get('file/..%2f..%2f.env', { 'x-test-pc': '1' })).status, 404)
    } finally { srv.close(); srv.closeAllConnections?.() }
  })
})
test('a release with a wrong signature is not put on Main either', async () => {
  const d = path.join(tmp, 'rel/forged')
  fs.cpSync(path.join(tmp, 'rel/two'), d, { recursive: true })
  const j = JSON.parse(fs.readFileSync(path.join(d, 'current.json')))
  j.manifest.short = 'forged1'
  fs.writeFileSync(path.join(d, 'current.json'), JSON.stringify(j))
  await assert.rejects(L.importRelease(d), /no release signed by Adal/)
})
