import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { withOwnNode } from '../src/routes/systemUpdate.js'

// (A Windows path holds ':', the PATH separator elsewhere: a plain path off Windows.)
const DIR = process.platform === 'win32' ? 'C:\\AdalKeep\\runtime' : '/opt/AdalKeep/runtime'

test("an update's package install finds Adal Keep's own Node first, with one PATH entry", () => {
  const env = withOwnNode({ Path: ['C:\Windows'].join(path.delimiter), A: '1' }, DIR)
  const keys = Object.keys(env).filter(k => k.toUpperCase() === 'PATH')
  assert.deepEqual(keys, ['Path'])
  assert.equal(env.Path.split(path.delimiter)[0], DIR)
  // Already there: not added twice.
  assert.equal(withOwnNode(env, DIR).Path, env.Path)
})
