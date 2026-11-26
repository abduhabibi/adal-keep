/**
 * packAnswers.js — big answers go packed (gzip): a list is about a tenth, and the office's
 * line is slow (Main's Wi-Fi 4–5 Mbit/s, a phone its own connection). Off the main thread.
 * (From 2026-11-17 to 2026-11-25 nothing was: the check held two backspace characters in
 * place of \b and never matched.) Not what the PCs send each other (sealed, it does not shrink), nor a copied file
 * on its way to this PC's own window (pictures do not shrink; packing megabytes only costs time).
 * Off: ADAL_PACK=0.
 */
import zlib from 'zlib'
const FROM = 2048

export function packAnswers(req, res, next) {
  if (process.env.ADAL_PACK === '0' || !/\bgzip\b/.test(req.headers['accept-encoding'] || '') || /^\/api\/(sync\b|app\/clipboard)/.test(req.path)) return next()
  const json = res.json.bind(res)
  res.json = (body) => {
    let text
    try { text = JSON.stringify(body) } catch { return json(body) }
    if (text === undefined || text.length < FROM || res.headersSent || req.method === 'HEAD') return json(body)
    zlib.gzip(text, { level: 5 }, (e, buf) => {
      if (res.headersSent || res.destroyed) return
      res.type('application/json')
      if (e) return res.send(text)
      res.set('Content-Encoding', 'gzip')
      res.append('Vary', 'Accept-Encoding')
      res.send(buf)
    })
    return res
  }
  next()
}
