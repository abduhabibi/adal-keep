import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { labourIdFrom, stopLabourOcr } from '../src/services/labourId.js'

after(stopLabourOcr)

// A pale passport page with a red block printed across its top, like the labour ID.
async function fixture(dir) {
  const W = 400, H = 300
  const raw = Buffer.alloc(W * H * 3, 235)
  for (let y = 20; y < 60; y++) for (let x = 60; x < 340; x++) { const i = (y * W + x) * 3; raw[i] = 230; raw[i + 1] = 30; raw[i + 2] = 30 }
  const file = path.join(dir, 'passport.png')
  await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file)
  return file
}

test('red print on the passport is cut out and the passport comes back without it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-test-'))
  try {
    const got = await labourIdFrom(await fixture(dir), dir)
    assert.ok(got, 'the red block is found')
    assert.ok(fs.existsSync(got.file) && fs.existsSync(got.passport))
    const { data, info } = await sharp(got.passport).raw().toBuffer({ resolveWithObject: true })
    const i = (40 * info.width + 200) * 3
    assert.ok(data[i] > 200 && data[i + 1] > 200, 'the block is painted over with the pale colour around it')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a passport with no red print gives nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-test-'))
  try {
    const file = path.join(dir, 'plain.png')
    await sharp({ create: { width: 200, height: 120, channels: 3, background: '#eeeeee' } }).png().toFile(file)
    assert.equal(await labourIdFrom(file, dir), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
