// The text of one PDF (stdin) as JSON on stdout; pdfText.js starts this and it ends at once.
const parts = []
for await (const d of process.stdin) parts.push(d)
try {
  const m = await import('pdf-parse')
  const buf = Buffer.concat(parts)
  let text = ''
  if (m.PDFParse) { const p = new m.PDFParse({ data: buf }); try { text = (await p.getText()).text || '' } finally { await p.destroy?.().catch?.(() => {}) } }
  else text = (await (m.default || m)(buf)).text || ''
  process.stdout.write(JSON.stringify({ text }), () => process.exit(0))
} catch (e) { process.stdout.write(JSON.stringify({ error: String(e?.message || e).slice(0, 300) }), () => process.exit(0)) }
