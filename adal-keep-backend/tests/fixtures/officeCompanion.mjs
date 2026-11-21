/**
 * A stand-in Adal Companion for the office tests (scratch, on a spare port):
 * its own headless Chromium as the robot browser, served like robot.go does
 * (/robot/json/version with the token), announced to the main PC every second
 * with how strong it says it is. No Supabase, no Telegram, nothing of a real PC.
 *
 *   node officeCompanion.mjs <mainPort> <id> <name> <powerJSON> <chromePath>
 */
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import puppeteer from 'puppeteer-core'

const [mainPort, id, name, powerJSON, chrome] = process.argv.slice(2)
const token = `tok_${id}_${'x'.repeat(20)}`
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `adal-companion-${id}-`))
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: dir, args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,800'], defaultViewport: { width: 1200, height: 800 } })

const srv = http.createServer((req, res) => {
  if (req.headers['x-adal-robot'] !== token) { res.writeHead(403); return res.end() }
  if (req.url.startsWith('/robot/json/version')) {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ Browser: 'stand-in', webSocketDebuggerUrl: browser.wsEndpoint() }))
  }
  res.writeHead(404); res.end()
})
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port
  const announce = () => {
    const body = JSON.stringify({ token, port, name, ...JSON.parse(powerJSON) })
    const r = http.request({ host: '127.0.0.1', port: Number(mainPort), path: '/api/companion/robot-browser', method: 'POST', headers: { 'content-type': 'application/json', 'x-test-pc': id } }, (res) => res.resume())
    r.on('error', () => {})
    r.end(body)
  }
  announce()
  setInterval(announce, 1000)
  console.log(`READY ${port}`)
})
const bye = async () => { try { await browser.close() } catch {} ; fs.rmSync(dir, { recursive: true, force: true }); process.exit(0) }
process.on('SIGTERM', bye)
process.on('SIGINT', bye)
