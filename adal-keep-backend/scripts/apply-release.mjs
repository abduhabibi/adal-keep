#!/usr/bin/env node
/**
 * Installs a signed release from a folder (or .zip) on THIS PC, with the
 * release's own code — so it works even when the server running here is
 * older than POST /api/system/update/apply-local (2026-11-19: the main PC's
 * internet could not download the release; it is copied over the LAN by scp).
 *
 *   <install>\runtime\node.exe apply-release.mjs [<release folder or .zip>] [--root C:\AdalKeep] [--force]
 *
 * (apply-release.ps1 next to it calls the route when the server has it, else
 * this, then restarts the server.) Nothing is installed unless Adal's
 * signature matches the manifest and every piece's SHA-256 matches it
 * (services/lanRelease.js importRelease, the same checks as every update).
 * Only Node's own modules here until the release's code is loaded.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? (argv.splice(i, 2)[1] || '') : '' }
const force = argv.includes('--force'); if (force) argv.splice(argv.indexOf('--force'), 1)
const rootArg = flag('--root')
let bundle = path.resolve(argv[0] || HERE)
const fail = (m) => { throw Object.assign(new Error(m), { mine: true }) }

// The install folder: --root, else the one this Node belongs to (<root>\runtime\node.exe), else C:\AdalKeep.
const isRoot = (d) => d && (fs.existsSync(path.join(d, 'backend', 'server.js')) || fs.existsSync(path.join(d, 'adal-keep-backend', 'server.js')))
const root = [rootArg, process.env.ADAL_PROJECT_ROOT, path.dirname(path.dirname(process.execPath)), 'C:\\AdalKeep'].find(isRoot)
if (!root) { console.error('✗ Adal Keep\'s install folder was not found (give --root C:\\AdalKeep)'); process.exit(1) }
const backendDir = fs.existsSync(path.join(root, 'backend', 'server.js')) ? path.join(root, 'backend') : path.join(root, 'adal-keep-backend')
const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

const work = fs.mkdtempSync(path.join(backendDir, '.apply-'))
try {
  // A .zip: unpacked first (Windows' tar.exe reads zip).
  if (fs.statSync(bundle).isFile()) {
    const into = path.join(work, 'bundle')
    fs.mkdirSync(into)
    if (process.platform !== 'win32' && /\.zip$/i.test(bundle)) execFileSync('unzip', ['-q', bundle, '-d', into])
    else execFileSync(tarExe, ['-xf', bundle, '-C', into], { windowsHide: true })
    bundle = into
  }
  const envFile = ['current.json', 'latest.json'].map(f => path.join(bundle, f)).find(f => fs.existsSync(f))
  if (!envFile) fail(`no current.json in ${bundle}`)
  const { manifest } = JSON.parse(fs.readFileSync(envFile, 'utf8'))
  const app = [path.join(bundle, 'files', manifest?.sha256 || '-'), path.join(bundle, manifest?.sha256 || '-'), path.join(bundle, path.basename(manifest?.file || '-'))].find(f => fs.existsSync(f))
  if (!app) fail('the app piece is not in the release folder')
  // The release's own code, unpacked inside the backend folder (so its packages load), runs the install.
  const code = path.join(work, 'code')
  fs.mkdirSync(code)
  execFileSync(tarExe, ['-xzf', app, '-C', code], { windowsHide: true })
  const entry = path.join(code, 'adal-keep-backend', 'src', 'routes', 'systemUpdate.js')
  if (!fs.existsSync(entry)) fail('the release has no backend')
  process.env.ADAL_PROJECT_ROOT = root
  process.env.ADAL_LAN_RELEASE_DIR = path.join(backendDir, 'data', 'lan-release')
  process.env.ADAL_LAN_UPDATES = '0'
  const S = await import(pathToFileURL(entry).href)
  if (typeof S.applyLocalRelease !== 'function') fail('this release cannot install itself from a file (too old)')
  console.log(`Installing ${manifest.short} into ${root} …`)
  const r = await S.applyLocalRelease(bundle, { force })
  if (r.log) console.log(r.log)
  if (r.error) fail(r.error)
  console.log(`✓ ${r.message}`)
  if (!r.alreadyUpToDate) console.log('RESTART_SERVER')
} catch (e) {
  console.error(`✗ ${e.message}`)
  process.exitCode = 1
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
process.exit(process.exitCode || 0)
