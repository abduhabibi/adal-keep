// Main's 16.8 MB update never finished on a slow line (2026-11-24): its .part went back from 15 MB
// to 3 MB again and again, silently. A download goes on from what is here whatever the server
// answers, one download per file at a time, says how far it is, and old half-downloads go.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-resume-'))
process.env.ADAL_LAN_RELEASE_DIR = path.join(T, 'rel')
const U = await import('../src/services/updateChannel.js')
const L = await import('../src/services/lanRelease.js')
const { diff } = await import('../src/services/bsdiff.js')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const data = crypto.randomBytes(400_000)
const quiet = { log() {}, warn() {}, error() {} }

// A server that ignores Range (always 200, the whole file) and drops the line after `cut` bytes each time.
const ignoresRange = (buf, cut) => async () => {
  let sent = false
  return new Response(new ReadableStream({
    pull(c) {
      if (!sent) { sent = true; c.enqueue(buf.subarray(0, cut)); return }
      if (cut >= buf.length) c.close(); else c.error(new Error('connection reset'))
    },
  }), { status: 200, headers: { 'content-length': String(buf.length) } })
}

test('a server that ignores Range and drops the line: the download goes on from what is here, never back to 0', async () => {
  const dest = path.join(T, 'whole.bin')
  const sizes = []
  let calls = 0
  const open = ignoresRange(data, 150_000)
  // Each answer brings the first 150 KB again; only what is new after the bytes here is kept.
  const growing = async (s, e, sig) => { calls++; sizes.push(fs.existsSync(`${dest}.part`) ? fs.statSync(`${dest}.part`).size : 0); return calls === 1 ? open() : ignoresRange(data, Math.min(data.length, 150_000 * calls))() }
  await U.rangedDownload(growing, dest, sha(data), { size: data.length, backoff: 1, log: quiet })
  assert.ok(fs.readFileSync(dest).equals(data))
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] >= sizes[i - 1], `the .part went back: ${sizes}`)
})

test('two installs at once share one download (never two writers on one .part)', async () => {
  const dest = path.join(T, 'twice.bin')
  let opened = 0
  const open = async (start, end) => {
    opened++
    await new Promise(r => setTimeout(r, 20))
    const to = Math.min(end, data.length - 1)
    return new Response(data.subarray(start, to + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${to}/${data.length}` } })
  }
  const [a, b] = await Promise.all([
    U.rangedDownload(open, dest, sha(data), { size: data.length, chunk: 100_000, log: quiet }),
    U.rangedDownload(open, dest, sha(data), { size: data.length, chunk: 100_000, log: quiet }),
  ])
  assert.equal(a, dest); assert.equal(b, dest)
  assert.equal(opened, 4, 'one download of 4 pieces, not two')
  assert.ok(fs.readFileSync(dest).equals(data))
})

test('it says how far it is, and why a try failed', async () => {
  const dest = path.join(T, 'said.bin')
  const lines = []
  const log = { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }
  let n = 0
  const open = async (start, end) => {
    if (n++ === 1) throw new Error('fetch failed')
    const to = Math.min(end, data.length - 1)
    return new Response(data.subarray(start, to + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${to}/${data.length}` } })
  }
  await U.rangedDownload(open, dest, sha(data), { size: data.length, chunk: 150_000, backoff: 1, log, label: 'release.tar.gz' })
  assert.ok(lines.some(l => /fetch failed at 0\.1 MB of 0\.4 MB/.test(l)), lines.join('\n'))
  assert.ok(lines.some(l => /release\.tar\.gz: done, 0\.4 MB \(checked\)/.test(l)), lines.join('\n'))
})

test('a download that does not match is said, not dropped silently', async () => {
  const dest = path.join(T, 'bad.bin')
  const lines = []
  const log = { log() {}, warn() {}, error: (m) => lines.push(m) }
  const open = async (start, end) => { const to = Math.min(end, data.length - 1); return new Response(data.subarray(start, to + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${to}/${data.length}` } }) }
  await assert.rejects(U.rangedDownload(open, dest, 'f'.repeat(64), { size: data.length, log }), /does not match/)
  assert.ok(lines.some(l => /does not match the signed SHA-256/.test(l)))
})

test('old half-downloads of pieces no release wants go; the wanted one stays', () => {
  const files = path.join(process.env.ADAL_LAN_RELEASE_DIR, 'files')
  fs.mkdirSync(files, { recursive: true })
  const wanted = 'a'.repeat(64), old = 'b'.repeat(64), fresh = 'c'.repeat(64)
  for (const h of [wanted, old, fresh]) fs.writeFileSync(path.join(files, `${h}.part`), 'x')
  const day = Date.now() - 24 * 3600 * 1000
  fs.utimesSync(path.join(files, `${wanted}.part`), day / 1000, day / 1000)
  fs.utimesSync(path.join(files, `${old}.part`), day / 1000, day / 1000)
  const gone = L.cleanParts({ file: 'release/x.tar.gz', sha256: wanted, size: 1 })
  assert.deepEqual(gone, [`${old}.part`])
  assert.ok(fs.existsSync(path.join(files, `${wanted}.part`)), 'the wanted one stays (the next try goes on from it)')
  assert.ok(fs.existsSync(path.join(files, `${fresh}.part`)), 'a recent one stays (a newer release may want it)')
})

test('a PC a few releases behind is rebuilt from the patch of the release it has (patches from the last releases)', async () => {
  const files = path.join(process.env.ADAL_LAN_RELEASE_DIR, 'files')
  const older = crypto.randomBytes(60_000)                                       // what this PC has (3 releases back)
  const newest = Buffer.concat([older.subarray(0, 50_000), crypto.randomBytes(15_000)])
  const pt = diff(older, newest)
  fs.writeFileSync(path.join(files, sha(older)), older)                          // the base is here
  fs.writeFileSync(path.join(files, sha(pt)), pt)                                // its patch already downloaded
  const manifest = {
    file: 'release/new.tar.gz', sha256: 'd'.repeat(64), size: 999_999,
    app_delta: {
      raw: { sha256: sha(newest), size: newest.length },
      patch: { from: 'e'.repeat(64), file: 'release/patches/from-previous.adalpatch', sha256: 'e'.repeat(64), size: 10 },   // the release before: not here
      patches: [{ from: sha(older), file: 'release/patches/from-older.adalpatch', sha256: sha(pt), size: pt.length, from_release: 'abc1234' }],
    },
  }
  const out = await L.fetchPiece(manifest, { file: manifest.file, sha256: manifest.sha256 }, null, { cloud: false })
  assert.ok(fs.readFileSync(out).equals(newest), 'rebuilt from the older release, no whole download')
})
