import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

process.env.ADAL_LAN_RELEASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-usbk-'))
const U = await import('../src/services/usbKeeper.js')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

const exe = Buffer.from('new program bytes')
const release = (lock = 'L1') => ({ manifest: { sha: 'a'.repeat(40), short: 'aaaaaaa', lock_hash: lock, programs: [{ name: 'AdalKeep.exe', sha256: sha(exe), file: 'x' }] } })
const usb = (over = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-'))
  fs.mkdirSync(path.join(root, 'deps'), { recursive: true })
  fs.writeFileSync(path.join(root, 'deps/source.sha'), over.lock ?? 'L1')
  fs.writeFileSync(path.join(root, '47040.pub'), 'KEY')
  fs.writeFileSync(path.join(root, 'deps/adal-check.ps1'), 'CHECK')
  return root
}
const cached = () => { const f = path.join(os.tmpdir(), `cached-${Math.random()}`); fs.writeFileSync(f, exe); return f }

test('only a drive called ADAL KEEP is found', async () => {
  const lister = async () => [{ root: 'D:\\', label: 'adal keep' }, { root: 'E:\\', label: 'OTHER' }, { root: 'F:\\', label: 'ADAL KEEP ' }]
  assert.deepEqual((await U.findDrives(lister)).map(d => d.root), ['D:\\', 'F:\\'])
})

test('the three states', () => {
  const r = release()
  assert.equal(U.inspect(usb({ lock: 'OLD' }), r).state, 'needs-prepare')
  const old = usb()
  assert.equal(U.inspect(old, r).state, 'old-installers')
  assert.equal(U.inspect(old, r).canFix, true)
  const noRelease = U.inspect(old, null)
  assert.equal(noRelease.state, 'current')
})

test('fix copies from the cache, becomes current, leaves 47040.pub and adal-check.ps1 alone, no temp files left', async () => {
  const root = usb()
  const r = release()
  const out = await U.fix(root, { release: r, fetchPiece: async () => cached(), label: 'ADAL KEEP' })
  assert.deepEqual(out.done.filter(n => n === 'AdalKeep.exe'), ['AdalKeep.exe'])
  assert.equal(fs.readFileSync(path.join(root, 'deps/programs/AdalKeep.exe')).equals(exe), true)
  assert.equal(fs.readFileSync(path.join(root, '47040.pub'), 'utf8'), 'KEY')
  assert.equal(fs.readFileSync(path.join(root, 'deps/adal-check.ps1'), 'utf8'), 'CHECK')
  const all = fs.readdirSync(root, { recursive: true })
  assert.equal(all.some(f => String(f).endsWith('.adal-tmp')), false)
  assert.match(out.eject, /Eject/)
  assert.ok(['current', 'old-installers'].includes(out.state))
  assert.equal(U.inspect(root, r).items.find(i => i.name === 'AdalKeep.exe').ok, true)
})

test('a copy that does not match is never renamed over the old file', async () => {
  const root = usb()
  fs.mkdirSync(path.join(root, 'deps/programs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'deps/programs/AdalKeep.exe'), 'OLD')
  const bad = path.join(os.tmpdir(), 'bad-piece'); fs.writeFileSync(bad, 'corrupt')
  const out = await U.fix(root, { release: release(), fetchPiece: async () => bad })
  assert.equal(out.failed.length >= 1, true)
  assert.equal(fs.readFileSync(path.join(root, 'deps/programs/AdalKeep.exe'), 'utf8'), 'OLD')
  assert.equal(fs.existsSync(path.join(root, 'deps/programs/AdalKeep.exe.adal-tmp')), false)
})

test('protected and escaping paths are refused; a wrong label writes nothing', async () => {
  const root = usb()
  const f = cached()
  for (const rel of ['47040.pub', '47040.PUB', 'deps\\adal-check.ps1', 'deps/./adal-check.ps1', '../evil', '/abs']) {
    await assert.rejects(U.safeWrite(root, rel, f), /not allowed/)
  }
  await assert.rejects(U.fix(root, { release: release(), label: 'MY DRIVE' }), /not called ADAL KEEP/)
  assert.equal(fs.existsSync(path.join(root, 'deps/programs')), false)
})
