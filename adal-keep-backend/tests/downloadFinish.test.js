// A download that reached its last byte must finish (2026-11-22: the agency's main PC kept a .part of exactly
// the signed size for ever, with CLOSE_WAIT sockets): a complete .part is promoted at the start, the signed size
// ends the loop without one more request, and a body that stops sending is cut (stall), not waited for.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const U = await import('../src/services/updateChannel.js')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-dl-'))
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const data = crypto.randomBytes(300_000)

const serve = (buf, { hangAfter = null } = {}) => {
  let hung = false
  return async (start, end, signal) => {
    if (start >= buf.length) return new Response(null, { status: 416 })
    const to = Math.min(end, buf.length - 1)
    const body = buf.subarray(start, to + 1)
    const stream = new ReadableStream({
      async start(c) {
        if (hangAfter != null && !hung && start + body.length > hangAfter) {
          hung = true
          c.enqueue(body.subarray(0, 1000))
          await new Promise((_, no) => signal.addEventListener('abort', () => no(signal.reason)))   // the server stops sending
        }
        c.enqueue(body); c.close()
      },
    })
    return new Response(stream, { status: 206, headers: { 'content-range': `bytes ${start}-${to}/${buf.length}` } })
  }
}

test('a complete .part is finished at the start, with no request', async () => {
  const dest = path.join(T, 'a.bin')
  fs.writeFileSync(`${dest}.part`, data)
  const out = await U.rangedDownload(() => { throw new Error('no request wanted') }, dest, sha(data), { size: data.length })
  assert.equal(out, dest)
  assert.ok(fs.readFileSync(dest).equals(data)); assert.equal(fs.existsSync(`${dest}.part`), false)
})

test('the signed size ends the loop: no request past the end (a server that hangs on one is never asked)', async () => {
  const dest = path.join(T, 'b.bin')
  fs.writeFileSync(`${dest}.part`, data.subarray(0, 100_000))
  let asked = []
  const open = serve(data)
  await U.rangedDownload((s, e, sig) => { asked.push(s); return open(s, e, sig) }, dest, sha(data), { size: data.length, chunk: 1 << 20 })
  assert.deepEqual(asked, [100_000], 'one request for the rest, none after it')
  assert.ok(fs.readFileSync(dest).equals(data))
})

test('a complete .part with the wrong content is thrown away, not installed', async () => {
  const dest = path.join(T, 'c.bin')
  fs.writeFileSync(`${dest}.part`, Buffer.alloc(data.length, 1))
  await assert.rejects(U.rangedDownload(serve(data), dest, sha(data), { size: data.length, tries: 2, backoff: 5 }), /does not match/)
  assert.equal(fs.existsSync(dest), false)
})

test('a body that stops sending is cut after the stall time and the download goes on from where it was', async () => {
  const dest = path.join(T, 'd.bin')
  const t0 = Date.now()
  await U.rangedDownload(serve(data, { hangAfter: 50_000 }), dest, sha(data), { chunk: 1 << 20, stall: 300, timeout: 20_000, tries: 4, backoff: 5 })
  assert.ok(fs.readFileSync(dest).equals(data))
  assert.ok(Date.now() - t0 < 10_000, 'did not wait for the long timeout')
})
