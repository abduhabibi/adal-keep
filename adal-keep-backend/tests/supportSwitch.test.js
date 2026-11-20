import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { supportOn, setSupport, flagPath, installRoot, supportRole } from '../src/services/supportSwitch.js'

test('remote support is on by default, off writes the flag, on removes it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-support-'))
  assert.equal(supportOn(root), true)
  assert.equal(setSupport(false, root, 'tester'), false)
  assert.ok(fs.existsSync(flagPath(root)))
  assert.match(fs.readFileSync(flagPath(root), 'utf8'), /off by tester at /)
  assert.equal(setSupport(true, root), true)
  assert.equal(fs.existsSync(flagPath(root)), false)
  assert.equal(setSupport(true, root), true)
})

test('install root: three levels above services; a Companion server in waiting maps to its install', () => {
  assert.equal(installRoot(path.resolve('/x/AdalKeep/backend/src/services')), path.resolve('/x/AdalKeep'))
  assert.equal(installRoot(path.resolve('/x/AdalKeepCompanion/server/backend/src/services')), path.resolve('/x/AdalKeepCompanion'))
  assert.equal(supportRole(fs.mkdtempSync(path.join(os.tmpdir(), 'adal-support-'))), 'Main')
})
