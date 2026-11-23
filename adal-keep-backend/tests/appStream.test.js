/**
 * appStream.test.js — one stream per window on the main PC (asked on 2026-11-23):
 * /api/app/alive?all=1 carries what changed and the double-C pictures too, so a
 * window holds one of the browser's 6 lines to the PC instead of three.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import express from 'express'

const { default: appRouter } = await import('../src/routes/app.js')
const { changed } = await import('../src/services/changes.js')
const { took } = await import('../src/services/screenClip.js')
const { _reset } = await import('../src/services/appLife.js')

test('the window\'s one stream: alive, changes and clips as named events', async () => {
  const app = express()
  app.use('/api', appRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  const got = []
  const req = http.get(`http://127.0.0.1:${server.address().port}/api/app/alive?all=1`, (res) => {
    res.setEncoding('utf8')
    res.on('data', (d) => got.push(d))
  })
  const until = async (re) => { for (let i = 0; i < 60 && !re.test(got.join('')); i++) await new Promise(r => setTimeout(r, 50)); return got.join('') }
  await until(/"windows":1/)
  changed('profiles')
  const withChange = await until(/event: changes\ndata: .*profiles/)
  assert.match(withChange, /event: changes\ndata: \{"v":\d+,"tables":\["profiles"\]\}/)
  took(Buffer.from('png'), '')
  const withClip = await until(/event: clips\ndata: \{"clip"/)
  assert.match(withClip, /event: clips\ndata: \{"hook":/)    // the watcher's state first
  assert.match(withClip, /event: clips\ndata: \{"clip":\d+/)
  // The plain "alive" messages stay unnamed (older pages read them as before).
  assert.match(withClip, /(^|\n)data: \{"runs":/)
  req.destroy()
  server.close()
  _reset()
})
