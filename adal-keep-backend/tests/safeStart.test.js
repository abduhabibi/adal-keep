import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { noteStart, startedWell, shouldRollBack, rollBack, savePrevious, rolledBack } from '../safeStart.js'

function install() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-safe-'))
  const back = path.join(root, 'backend')
  fs.mkdirSync(path.join(back, 'src'), { recursive: true })
  fs.mkdirSync(path.join(back, 'data'), { recursive: true })
  fs.mkdirSync(path.join(root, 'adal-keep-frontend', 'dist'), { recursive: true })
  const put = (v) => {
    fs.writeFileSync(path.join(back, 'src', 'app.js'), `export default '${v}'`)
    fs.writeFileSync(path.join(root, 'adal-keep-frontend', 'dist', 'index.html'), `<p>${v}</p>`)
    fs.writeFileSync(path.join(root, '.adal-version.json'), JSON.stringify({ sha: v, savedAt: new Date().toISOString() }))
  }
  return { root, back, put }
}

test('a new version that fails to start 3 times goes back to the one before it; data stays', () => {
  const { root, back, put } = install()
  put('good111')
  fs.writeFileSync(path.join(back, 'data', 'keep.txt'), 'her data')
  assert.equal(savePrevious(back, ['src']), true)
  put('bad2222')

  for (let i = 1; i <= 2; i++) assert.equal(shouldRollBack(back, noteStart(back)), null)
  const third = noteStart(back)
  assert.equal(third.starts, 3)
  const prev = shouldRollBack(back, third)
  assert.equal(prev.sha, 'good111')
  const r = rollBack(back, prev, 'test')
  assert.deepEqual([r.from, r.to], ['bad2222', 'good111'])
  assert.match(fs.readFileSync(path.join(back, 'src', 'app.js'), 'utf8'), /good111/)
  assert.match(fs.readFileSync(path.join(root, 'adal-keep-frontend', 'dist', 'index.html'), 'utf8'), /good111/)
  assert.equal(fs.readFileSync(path.join(back, 'data', 'keep.txt'), 'utf8'), 'her data')
  assert.equal(rolledBack(back).from, 'bad2222')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.adal-version.json'), 'utf8')).rolledBackFrom, 'bad2222')
  // The version put back starts counting from zero.
  assert.equal(noteStart(back).starts, 1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a start that went well resets the count; an old version or a git checkout is never rolled back', () => {
  const { root, back, put } = install()
  put('one1111'); savePrevious(back, ['src']); put('two2222')
  noteStart(back); noteStart(back); startedWell(back)
  assert.equal(shouldRollBack(back, noteStart(back)), null)
  // Installed 3 days ago: failing now is not the update's fault.
  fs.writeFileSync(path.join(root, '.adal-version.json'), JSON.stringify({ sha: 'two2222', savedAt: new Date(Date.now() - 3 * 864e5).toISOString() }))
  let info; for (let i = 0; i < 4; i++) info = noteStart(back)
  assert.equal(shouldRollBack(back, info), null)
  // No version file (a developer's copy): nothing is counted.
  fs.rmSync(path.join(root, '.adal-version.json'))
  assert.equal(noteStart(back).guarded, false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('server.js: a main.js that cannot load, 3 times, puts the previous version back', () => {
  const { root, back, put } = install()
  const here = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  fs.copyFileSync(path.join(here, 'server.js'), path.join(back, 'server.js'))
  fs.copyFileSync(path.join(here, 'safeStart.js'), path.join(back, 'safeStart.js'))
  fs.writeFileSync(path.join(back, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(back, 'main.js'), `console.log('started')`)
  put('good111'); savePrevious(back, ['main.js', 'src'])
  put('bad2222'); fs.writeFileSync(path.join(back, 'main.js'), `this is not javascript (`)
  const start = () => { try { return { code: 0, out: execFileSync(process.execPath, ['server.js'], { cwd: back, encoding: 'utf8', stdio: 'pipe' }) } } catch (e) { return { code: e.status, out: String(e.stdout) } } }
  assert.equal(start().code, 1)
  assert.equal(start().code, 1)
  assert.equal(start().code, 1) // the third failure puts the good version back
  const ok = start()
  assert.equal(ok.code, 0)
  assert.match(ok.out, /started/)
  assert.equal(rolledBack(back).from, 'bad2222')
  fs.rmSync(root, { recursive: true, force: true })
})
