import test from 'node:test'
import assert from 'node:assert/strict'

test('Musaned stages only move forward; a plain HR pool status never overwrites a contract stage', async () => {
  const { newerStage, musanedStep } = await import('../src/services/musanedStages.js')
  assert.equal(musanedStep('FMOL APPROVED'), 3)
  assert.equal(newerStage('EPRO APPROVAL', 'FMOL APPROVAL'), 'FMOL APPROVAL')
  assert.equal(newerStage('FMOL APPROVAL', 'EPRO APPROVAL'), null)
  assert.equal(newerStage('FMOL APPROVAL', 'Available'), null)
  assert.equal(newerStage('', 'Available'), 'AVAILABLE')
  assert.equal(newerStage('IN OUR LIST', 'Sent to Saudi Embassy'), 'SENT TO SAUDI EMBASSY')
})

test('the journey: ten steps from Musaned\'s own stages; on Musaned and not chosen is "waiting"', async () => {
  const { journeyOf } = await import('../src/routes/automations.js')
  const keys = (j) => j.embassy.map(s => s.key)
  const states = (p, runs) => Object.fromEntries(journeyOf(p, runs).embassy.map(s => [s.key, s.state]))
  assert.deepEqual(keys(journeyOf({})), ['cv', 'musaned', 'selected', 'wafid', 'epro', 'insurance', 'fmol', 'embassy', 'visa', 'arrived'])
  assert.equal(states({ musaned_stage: 'IN OUR LIST' }).musaned, 'waiting')
  const fmol = states({ musaned_stage: 'FMOL APPROVAL', chosen_at: '2026-11-01' })
  assert.equal(fmol.selected, 'done'); assert.equal(fmol.epro, 'done'); assert.equal(fmol.fmol, 'active'); assert.equal(fmol.visa, 'todo')
  const emb = states({ musaned_stage: 'SENT TO SAUDI EMBASSY', chosen_at: '2026-11-01' })
  assert.equal(emb.embassy, 'done'); assert.equal(emb.visa, 'active'); assert.equal(emb.insurance, 'done')
  assert.equal(states({ musaned_stage: 'ARRIVED KSA', chosen_at: 'x' }).arrived, 'done')
  // The wakala is kept apart (the list's Paid / Unpaid buttons).
  assert.equal(journeyOf({ chosen_at: 'x', musaned_payment: 'Unpaid' }).extra[0].state, 'failed')
})

test('the header CVs share is cut out of them (the name under it differs)', async () => {
  const fs = await import('fs'), os = await import('os'), path = await import('path')
  const { createRequire } = await import('module')
  let sharp
  try { sharp = (await import('sharp')).default } catch { sharp = createRequire('C:/AdalKeep/backend/package.json')('sharp') }
  const { commonHeader } = await import('../src/services/cvHeader.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvh-'))
  const cv = async (i) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#fff"/>
      <rect width="600" height="90" fill="#1d5c3a"/><text x="20" y="55" font-size="30" fill="#fff">AGENCY APPLICATION FOR EMPLOYMENT</text>
      <text x="${40 + i * 90}" y="${150 + i * 30}" font-size="40" fill="#000">NAME ${i} ${'X'.repeat(i + 3)}</text>
      <rect x="${30 + i * 120}" y="200" width="${150 + i * 40}" height="400" fill="#${['c33', '3c3', '33c'][i]}"/></svg>`
    const f = path.join(dir, `cv${i}.png`)
    await sharp(Buffer.from(svg)).png().toFile(f)
    return f
  }
  const files = [await cv(0), await cv(1), await cv(2)]
  const got = await commonHeader(files)
  assert.ok(got, 'a header was found')
  assert.ok(got.height >= 85 && got.height <= 130, `header height ${got.height}`)
  fs.rmSync(dir, { recursive: true, force: true })
})
