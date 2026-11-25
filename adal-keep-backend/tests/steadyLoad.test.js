/**
 * steadyLoad.test.js — 2026-11-25, Main: the office line loses new connections in bursts (2 of 12 never answered).
 * A page whose connection is lost is asked for again within seconds; a slow page that has begun to answer is not cut
 * off; a sign-in coming back to Musaned is never loaded over. Real Chrome, a server that swallows connections.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { findChrome, rmTmp } from './helpers/chrome.js'
import { steadyGoto, inCallback, lostConnection } from '../src/services/steadyLoad.js'
const CHROME = findChrome()

test('what is a lost connection, and a sign-in coming back', () => {
  assert.equal(lostConnection('net::ERR_CONNECTION_TIMED_OUT at https://x'), true)
  assert.equal(lostConnection('net::ERR_ABORTED'), false)
  assert.equal(inCallback('https://tawtheeq.musaned.com.sa/#state=abc&session_state=x&code=y'), true)
  assert.equal(inCallback('https://tawtheeq.musaned.com.sa/login?state=a&code=b'), true)
  assert.equal(inCallback('https://tawtheeq.musaned.com.sa/hr-pool?state=SA'), false)
  assert.equal(inCallback('https://accounts.wahid.sa/auth?state=a&code=b'), false)
})

test('a lost answer is asked for again at once; a slow one is waited for', { skip: !CHROME && 'no Chrome', timeout: 80000 }, async (t) => {
  let n = 0, mode = ''
  const srv = http.createServer((q, r) => {
    if (q.url === '/favicon.ico') return r.end()
    n++
    if (mode === 'lose2' && n <= 2) return                         // never answered
    if (mode === 'drop' && n <= 2) return q.socket.destroy()
    r.setHeader('content-type', 'text/html')
    if (mode === 'slow') { r.write('<!doctype html><title>x</title>'); return setTimeout(() => r.end('<h1>slow</h1>'), 4000) }
    r.end('<h1>there</h1>')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-steady-'))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: tmp, args: ['--no-first-run'] })
  t.after(async () => { await b.close().catch(() => {}); srv.closeAllConnections?.(); srv.close(); rmTmp(tmp) })
  const p = await b.newPage(), logs = []
  mode = 'lose2'; n = 0
  let t0 = Date.now()
  await steadyGoto(p, url, { answerMs: 1500, totalMs: 20000, log: (m) => logs.push(m) })
  console.log(`two lost answers: the page after ${Date.now() - t0} ms (waited 1.5 s each; one 60 s wait before)`)
  assert.equal(await p.evaluate(() => document.body.innerText), 'there'); assert.ok(Date.now() - t0 < 7000); assert.match(logs.join('\n'), /asking again \(try 3\)/)
  mode = 'drop'; n = 0
  await steadyGoto(p, url, { answerMs: 1500, totalMs: 20000 })
  assert.equal(await p.evaluate(() => document.body.innerText), 'there')
  mode = 'slow'; n = 0
  await steadyGoto(p, url, { answerMs: 1500, totalMs: 20000 })
  assert.equal(n, 1, 'a page that has begun to answer is asked for once')
  assert.equal(await p.evaluate(() => document.body.innerText), 'slow')
  mode = 'lose2'; n = -100
  t0 = Date.now()
  await assert.rejects(steadyGoto(p, url, { answerMs: 1500, totalMs: 6000 }), /Navigation timeout/)
  assert.ok(Date.now() - t0 < 9000)
})
