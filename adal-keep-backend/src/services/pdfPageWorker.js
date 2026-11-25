/** Draws the first page of a PDF, in its own thread (services/pictures.js pdfFirstPagePng). */
import fs from 'fs'
import { parentPort } from 'worker_threads'

parentPort.on('message', async ({ id, abs }) => {
  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(fs.readFileSync(abs), 'application/pdf')
    try {
      if (!doc.countPages()) throw new Error('no pages')
      const page = doc.loadPage(0)
      const pix = page.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
      const png = pix.asPNG()
      pix.destroy?.(); page.destroy?.()
      parentPort.postMessage({ id, png })
    } finally { doc.destroy?.() }
  } catch (e) { parentPort.postMessage({ id, error: e?.message || String(e) }) }
})
