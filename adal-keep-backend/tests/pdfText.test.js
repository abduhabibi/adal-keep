// A PDF is read in a program of its own: its memory comes back (pdfText.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { pdfText } from '../src/services/pdfText.js'

// A small real PDF with one line of text.
function pdf(line) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const s = `BT /F1 12 Tf 20 100 Td (${line}) Tj ET`
  objs[3] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`
  let out = '%PDF-1.4\n'; const off = []
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 6\n0000000000 65535 f \n${off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`
  return Buffer.from(out, 'latin1')
}
test('the same text as before, in this program or its own; the memory stays out of this one', async () => {
  const buf = pdf('Medical examination date : 12/10/2026')
  const before = process.memoryUsage.rss()
  const [a, b] = await Promise.all([pdfText(buf), pdfText(buf)])
  const grew = (process.memoryUsage.rss() - before) / 1e6
  assert.match(a, /Medical examination date : 12\/10\/2026/); assert.equal(a, b)
  assert.ok(grew < 40, `this program grew ${grew.toFixed(0)} MB`)
  await assert.rejects(pdfText(Buffer.from('not a pdf')))
  const { medicalDeadline } = await import('../src/services/medicalValidity.js')
  assert.deepEqual(medicalDeadline(a), { exam: '2026-10-12', until: '2026-12-12' })
  process.env.ADAL_PDF_CHILD = '0'
  try { assert.equal(await pdfText(buf), a) } finally { delete process.env.ADAL_PDF_CHILD }
  assert.match(await pdfText(buf), /Medical/)
})
