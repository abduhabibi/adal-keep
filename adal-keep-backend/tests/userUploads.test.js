// While someone uploads files into Adal Keep, the online copy and the backup
// wait; they go on about 30 s after the last upload — nothing skipped.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { isUserUpload, trackUserUploads, uploadsBusy, waitForQuiet, QUIET_MS, _setClock, _reset } from '../src/services/userUploads.js'

let now = 1_000_000
_setClock(() => now)
test.after(() => _setClock(null))

const req = (method, p, headers = {}) => ({ method, path: p, headers })
const upload = () => {
  const res = new EventEmitter()
  trackUserUploads(req('POST', '/api/profiles/7/files', { 'content-type': 'multipart/form-data; boundary=x' }), res, () => {})
  return res
}

test('what counts as the user uploading', () => {
  assert.equal(isUserUpload(req('POST', '/api/profiles/7/files', { 'content-type': 'multipart/form-data; boundary=x' })), true)
  assert.equal(isUserUpload(req('POST', '/api/companion/ingest', { 'content-type': 'application/octet-stream' })), true)
  assert.equal(isUserUpload(req('PUT', '/api/profiles/7', { 'content-type': 'application/json', 'content-length': '2000000' })), true)
  assert.equal(isUserUpload(req('POST', '/api/profiles/7', { 'content-type': 'application/json', 'content-length': '300' })), false)
  assert.equal(isUserUpload(req('GET', '/api/files/3/download')), false)
  assert.equal(isUserUpload(req('POST', '/api/replica/piece', { 'content-type': 'multipart/form-data' })), false)
})

test('busy while uploading and for 30 s after the last one ends', () => {
  _reset()
  assert.equal(uploadsBusy(), false)
  const a = upload(), b = upload()
  assert.equal(uploadsBusy(), true)
  a.emit('finish'); a.emit('close')       // counted once
  now += 60_000
  assert.equal(uploadsBusy(), true)       // b still going
  b.emit('close')
  now += QUIET_MS - 1000
  assert.equal(uploadsBusy(), true)
  now += 1000
  assert.equal(uploadsBusy(), false)
})

test('the uploads to the internet wait, then all go, in order', async () => {
  _reset()
  const sent = []
  const queue = ['doc-1', 'doc-2', 'doc-3']
  const u = upload()
  const pusher = (async () => { for (const d of queue) { await waitForQuiet({ every: 5 }); sent.push(d) } })()
  await new Promise(ok => setTimeout(ok, 30))
  assert.deepEqual(sent, [])               // nothing while the user uploads
  u.emit('finish')
  await new Promise(ok => setTimeout(ok, 30))
  assert.deepEqual(sent, [])               // nor in the 30 s after
  now += QUIET_MS
  await pusher
  assert.deepEqual(sent, queue)            // then every one, none skipped
})
