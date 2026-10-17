/**
 * packaged-sync.cjs — runs after `npm install` (postinstall).
 *
 * Older builds of the Settings-page updater unpacked a new version into
 * <root>\adal-keep-backend on a USB install, while the server runs from
 * <root>\backend — so the update never reached the running server. When this
 * package is installed in exactly that spot, copy the code over to <root>\backend.
 * Anywhere else (a developer checkout, PREPARE, the new updater, which installs
 * in <root>\backend itself) it does nothing.
 *
 * Never copies data, uploads, logs, node_modules or .env.
 */
const fs = require('fs')
const path = require('path')

const here = process.cwd()
const root = path.dirname(here)
const target = path.join(root, 'backend')

const isOldUpdaterCopy =
  path.basename(here) === 'adal-keep-backend' &&
  fs.existsSync(path.join(target, 'server.js')) &&
  fs.existsSync(path.join(root, 'run-server.bat')) &&
  fs.existsSync(path.join(here, 'server.js'))

if (!isOldUpdaterCopy) process.exit(0)

const SKIP = new Set(['node_modules', 'data', 'uploads', 'logs', '.env', '.env.bak', '.git', 'data.sqlite', 'data.sqlite-shm', 'data.sqlite-wal'])
const copy = (name) => {
  const from = path.join(here, name)
  if (!fs.existsSync(from)) return
  fs.cpSync(from, path.join(target, name), {
    recursive: true,
    force: true,
    filter: (src) => !path.relative(here, src).split(path.sep).some((p) => SKIP.has(p)),
  })
}

try {
  for (const name of ['src', 'scripts', 'server.js', 'knexfile.js', 'package.json', 'package-lock.json', 'eng.traineddata', 'amh.traineddata']) copy(name)
  console.log(`[packaged-sync] update copied into ${target} — restart Adal Keep (or the PC) to load it`)
} catch (e) {
  // Never fail the install because of this step.
  console.log(`[packaged-sync] could not copy into ${target}: ${e.message}`)
}
