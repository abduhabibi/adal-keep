// A browser for a test, on Linux, Windows or a Mac; '' without one. And a temp folder taken away (Windows keeps a
// browser's files open a moment after it ended: EPERM / EBUSY is not a failed test).
import fs from 'fs'
import path from 'path'

export function findChrome() {
  const W = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
  const win = W.flatMap(d => [['Google', 'Chrome', 'Application', 'chrome.exe'], ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'], ['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Chromium', 'Application', 'chrome.exe']].map(p => path.join(d, ...p)))
  return [process.env.TEST_BROWSER, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ...win].find(f => f && fs.existsSync(f)) || ''
}
export function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (e) { if (process.platform !== 'win32') throw e }
}
