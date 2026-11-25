/**
 * Adal Keep's window opens ONLY when a person opens it (the owner, 2026-11-24: "don't make
 * Adal open by itself in any way … never open after X is clicked"). These checks fail when
 * any code path can open the app window, a second window, or a robot window by itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const files = (dir, re) => {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!/node_modules|dist|tests?$|\.git/.test(e.name)) walk(p) } else if (re.test(e.name) && !/_test\.go$|\.test\.js$/.test(e.name)) out.push(p)
    }
  }
  walk(dir)
  return out
}
// A Go function's body (from "func name(" to the next top-level "func ").
const goFunc = (src, name) => { const i = src.indexOf(`func ${name}(`); assert.ok(i >= 0, `func ${name} missing`); const j = src.indexOf('\nfunc ', i + 1); return src.slice(i, j < 0 ? undefined : j) }

test('the server never starts the app window, a browser window for people, or the default browser', () => {
  const bad = []
  for (const f of [...files('adal-keep-backend/src', /\.js$/), 'adal-keep-backend/main.js', 'adal-keep-backend/server.js']) {
    const s = read(f)
    for (const [re, why] of [
      [/--app=/, 'an --app window'],
      [/app-window|ui-profile/, "the app window's profile"],
      [/['"`](xdg-open|rundll32|explorer(\.exe)?|open-adal-keep\.sh)['"`]/, 'opens a window / the default browser'],
      [/AdalKeep\.exe['"`]\s*,\s*\[(?![^\]]*--background)/, 'starts AdalKeep.exe without --background'],
    ]) if (re.test(s)) bad.push(`${f}: ${why}`)
  }
  assert.deepEqual(bad, [])
})

test('Windows launcher: a start without a person (sign-in, update, restart) never opens the window', () => {
  const main = read('adal-launcher/main.go')
  const emp = read('adal-launcher/employee.go')
  assert.ok(!/openAtStart|open-at-start/.test(main + emp), '"open when the PC starts" is gone')
  const m = goFunc(main, 'main')
  // Every open in main() is under `if !background` (or the person's second click: also !background).
  const opens = [...m.matchAll(/openMainOrFollowed\(|openUI\(|openAppWindow\(/g)].map(x => x.index)
  assert.ok(opens.length >= 1)
  for (const at of opens) {
    const before = m.slice(Math.max(0, at - 120), at)
    assert.match(before, /if !background \{\s*$/, `an open in main() not guarded by !background: …${before.slice(-60)}`)
  }
  // Companion / employee PC: the background start parks before any open.
  const run = goFunc(emp, 'runEmployee')
  const park = run.indexOf('if background {\n\t\tselect {}')
  assert.ok(park > 0, 'runEmployee parks a background start')
  const firstCopyPart = run.indexOf('logf("Adal Keep (employee PC) starting")')
  assert.ok(!/openAppWindow\(/.test(run.slice(firstCopyPart, park)), 'nothing opens before the background park')
  // A second copy (the person clicked the icon again) is never a background one.
  assert.match(main, /background := len\(args\) > 0 && args\[0\] == "--background"/)
  assert.match(main, /if !first \{\s*if !background \{\s*openMainOrFollowed\(root\)/)
})

test('Windows: opening Adal Keep again brings its window to the front, never a second one', () => {
  const emp = read('adal-launcher/employee.go')
  const open = goFunc(emp, 'openAppWindow')
  const focus = open.indexOf('focusAppWindow(root)')
  const launch = open.indexOf('exec.Command(')
  assert.ok(focus > 0 && focus < launch, 'openAppWindow looks for the open window before starting a browser')
  assert.match(read('adal-launcher/single.go'), /SetForegroundWindow/)
  // A profile in use (the last window still closing) is waited for: looked for before each new try, one opener at a
  // time, and the default browser only for the click the program was started by (openwindow.go).
  assert.ok(open.indexOf('openingNow()') > focus && open.indexOf('openingNow()') < launch, 'one opener at a time')
  assert.match(open, /time\.Since\(programStart\) < 2\*time\.Minute \{\s*o\.lastResort = /)
  const ow = read('adal-launcher/openwindow.go')
  const again = goFunc(ow, '(o windowOpener) again')
  assert.ok(again.lastIndexOf('o.focus()') < again.lastIndexOf('o.start(b)') && again.lastIndexOf('o.focus()') > 0, 'the window is looked for before every new try')
  assert.ok(!/rundll32|xdg-open/.test(ow))
})

test('the installer starts only the server; its window opens from the icon or the finish box', () => {
  const nsi = read('adal-installer/usb-installer.nsi')
  for (const line of nsi.split('\n').filter(l => /^\s*Exec\s+'"\$INSTDIR\\AdalKeep\.exe"/.test(l))) assert.match(line, /--background/)
})

test('the Go Companion never starts a browser or a window', () => {
  const bad = []
  for (const f of files('adal-companion', /\.go$/)) {
    const s = read(f)
    if (/--app=|rundll32|xdg-open|AdalBrowser\.exe"\s*,|msedge|chrome\.exe/.test(s.replace(/\/\/.*$/gm, ''))) bad.push(f)
  }
  // (robot.go starts the robot's own hidden agent, not a browser window.)
  assert.deepEqual(bad.filter(f => !/browserpath|robot\.go/.test(f)), [])
})

test('Linux: only the icon opens the window; one window; no old windows back; X closes it', () => {
  const sh = read('adal-installer/linux/open-adal-keep.sh')
  assert.match(sh, /\/json\/activate\//, 'an open window is brought to the front')
  assert.ok(sh.indexOf('/json/activate/') < sh.indexOf('exec "$BROWSER"'), 'looked for before starting a browser')
  assert.match(sh, /Default\/Sessions/, "the last session's windows are not restored")
  assert.match(sh, /background_mode/, 'the browser does not stay in the background after X')
  assert.match(sh, /--hide-crash-restore-bubble/)
  // The service starts only the server.
  const unit = read('adal-installer/linux/install-linux-app.sh')
  assert.ok(!/ExecStart=.*(open-adal-keep|brave|chrome|xdg-open)/.test(unit))
  // Nothing on Linux opens the script but the desktop entry.
  const callers = [...files('adal-keep-backend/src', /\.js$/), ...files('adal-companion', /\.go$/), ...files('adal-launcher', /\.go$/)].filter(f => /open-adal-keep/.test(read(f)))
  assert.deepEqual(callers, [])
})
