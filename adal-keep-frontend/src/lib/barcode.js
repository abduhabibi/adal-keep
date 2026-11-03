/**
 * Code 128 barcodes as SVG (code set B: letters and digits — "E828524096",
 * "1908236040"), for the embassy page and the visa box. No library needed.
 */
const P = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112']
const START_B = 104, STOP = 106

/** The bars of `text`: [{x, w}] in modules, and the whole width. */
export function code128(text) {
  const s = String(text || '').replace(/[^\x20-\x7e]/g, '')
  const codes = [START_B, ...[...s].map(c => c.charCodeAt(0) - 32)]
  let sum = START_B
  codes.slice(1).forEach((v, i) => { sum += v * (i + 1) })
  codes.push(sum % 103, STOP)
  const bars = []
  let x = 10 // quiet zone
  for (const v of codes) {
    const widths = P[v]
    for (let i = 0; i < widths.length; i++) {
      const w = Number(widths[i])
      if (i % 2 === 0) bars.push({ x, w })
      x += w
    }
  }
  return { bars, width: x + 10 }
}

/** An <svg> string: the barcode, `height` px high, stretched to `width` px. */
export function barcodeSvg(text, { width = 260, height = 50 } = {}) {
  if (!text) return ''
  const { bars, width: m } = code128(text)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m} 50" width="${width}" height="${height}" preserveAspectRatio="none" shape-rendering="crispEdges">` +
    `<rect width="${m}" height="50" fill="#fff"/>` +
    bars.map(b => `<rect x="${b.x}" y="0" width="${b.w}" height="50" fill="#000"/>`).join('') + '</svg>'
}
