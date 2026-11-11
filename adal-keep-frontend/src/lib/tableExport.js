/**
 * A small table (the selected girls: Name | Labour ID | Passport) saved as a
 * file, made right here in the page — no server, no library:
 *   pdf · xls · xlsx · rtf · docx · mht · html · txt · csv · png (image)
 * xlsx and docx are real Office files (a zip made here), xls is Excel's XML
 * spreadsheet, the rest are plain text formats; the image is drawn on a canvas.
 */

export const FORMATS = ['pdf', 'xls', 'xlsx', 'rtf', 'docx', 'mht', 'html', 'txt', 'csv', 'image']

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const enc = new TextEncoder()

// ── zip (stored, no compression) ────────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
function zip(files) {
  const parts = [], central = []
  let off = 0
  for (const [name, text] of files) {
    const n = enc.encode(name), d = enc.encode(text), crc = crc32(d)
    const h = new DataView(new ArrayBuffer(30))
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true)
    h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, n.length, true)
    parts.push(new Uint8Array(h.buffer), n, d)
    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true)
    c.setUint32(16, crc, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true)
    central.push(new Uint8Array(c.buffer), n)
    off += 30 + n.length + d.length
  }
  const size = central.reduce((a, b) => a + b.length, 0)
  const e = new DataView(new ArrayBuffer(22))
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true)
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)])
}

const col = (i) => String.fromCharCode(65 + i)
function xlsx(head, rows) {
  const cell = (v, r, c, s) => `<c r="${col(c)}${r}" t="inlineStr"${s ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${head.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i ? 18 : 34}" customWidth="1"/>`).join('')}</cols><sheetData>` +
    [head, ...rows].map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, ri + 1, ci, ri === 0)).join('')}</row>`).join('') + '</sheetData></worksheet>'
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Selected" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD3D3D3"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ])
}

function docx(title, head, rows) {
  const tc = (v, b) => `<w:tc><w:p><w:r>${b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(v)}</w:t></w:r></w:p></w:tc>`
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:color="999999"/>`).join('')
  const body = `<w:p><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>${esc(title)}</w:t></w:r></w:p>` +
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>` +
    [head, ...rows].map((r, i) => `<w:tr>${r.map(v => tc(v, i === 0)).join('')}</w:tr>`).join('') + '</w:tbl>'
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`],
  ])
}

function xls(head, rows) {
  const row = (r, b) => `<Row>${r.map(v => `<Cell${b ? ' ss:StyleID="h"' : ''}><Data ss:Type="String">${esc(v)}</Data></Cell>`).join('')}</Row>`
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#D3D3D3" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="Selected"><Table><Column ss:Width="200"/><Column ss:Width="110"/><Column ss:Width="110"/>${row(head, true)}${rows.map(r => row(r)).join('')}</Table></Worksheet></Workbook>`
}

function html(title, head, rows) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Calibri,Arial,sans-serif;margin:24px}table{border-collapse:collapse}th,td{border:1px solid #999;padding:6px 12px;text-align:left}th{background:#d3d3d3}</style></head><body><h2>${esc(title)}</h2><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`
}

function rtf(title, head, rows) {
  const t = (s) => String(s ?? '').replace(/[\\{}]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0) > 32767 ? c.charCodeAt(0) - 65536 : c.charCodeAt(0)}?`)
  const widths = [4200, 2600, 2600]
  const row = (r, b) => '\\trowd\\trgaph108' + widths.map((_, i) => `\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs\\cellx${widths.slice(0, i + 1).reduce((a, c) => a + c, 0)}`).join('') +
    r.map(v => `\\pard\\intbl${b ? '\\b ' : ' '}${t(v)}${b ? '\\b0' : ''}\\cell`).join('') + '\\row\n'
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\f0\\fs22{\\b\\fs28 ${t(title)}\\par}\\par\n${row(head, true)}${rows.map(r => row(r)).join('')}\\pard\\par}`
}

function mht(title, head, rows) {
  const b = '----=_adal_keep'
  return `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${b}"; type="text/html"\r\n\r\n--${b}\r\nContent-Type: text/html; charset="utf-8"\r\nContent-Location: file:///selected.htm\r\n\r\n${html(title, head, rows)}\r\n\r\n--${b}--\r\n`
}

function txt(head, rows) {
  const all = [head, ...rows]
  const w = head.map((_, i) => Math.max(...all.map(r => String(r[i] ?? '').length)))
  const line = (r) => r.map((v, i) => String(v ?? '').padEnd(w[i])).join('  |  ').trimEnd()
  return [line(head), w.map(n => '-'.repeat(n)).join('--+--'), ...rows.map(line)].join('\r\n') + '\r\n'
}

const csv = (head, rows) => '\ufeff' + [head, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n'

/** A one-or-more page PDF (A4) with the table drawn in Helvetica. */
function pdf(title, head, rows) {
  const W = 595, H = 842, M = 40, RH = 20, widths = [255, 130, 130]
  const latin = (s) => String(s ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, m => '\\' + m)
  const perPage = Math.floor((H - 2 * M - 40) / RH) - 1
  const pages = []
  for (let i = 0; i < Math.max(1, rows.length); i += perPage) pages.push(rows.slice(i, i + perPage))
  const objs = []
  const add = (s) => { objs.push(s); return objs.length }
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  const pagesId = objs.length + 1 + pages.length * 2
  const kids = []
  pages.forEach((chunk, pi) => {
    let s = `BT /F2 14 Tf ${M} ${H - M - 14} Td (${latin(title)}${pages.length > 1 ? ` - page ${pi + 1}/${pages.length}` : ''}) Tj ET\n0.6 G 0.5 w\n`
    let y = H - M - 40
    ;[head, ...chunk].forEach((r, ri) => {
      if (ri === 0) s += `0.83 g ${M} ${y - RH} ${widths.reduce((a, b) => a + b)} ${RH} re f 0 g\n`
      let x = M
      r.forEach((v, ci) => {
        s += `${x} ${y - RH} ${widths[ci]} ${RH} re S\nBT /F${ri === 0 ? 2 : 1} 10 Tf ${x + 5} ${y - RH + 6} Td (${latin(v)}) Tj ET\n`
        x += widths[ci]
      })
      y -= RH
    })
    const content = add(`<< /Length ${s.length} >>\nstream\n${s}endstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`))
  })
  add(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`)
  const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = '%PDF-1.4\n'
  const xref = []
  objs.forEach((o, i) => { xref.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const start = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${start}\n%%EOF`
  return new Blob([Uint8Array.from(out, c => c.charCodeAt(0) & 0xff)], { type: 'application/pdf' })
}

function image(title, head, rows) {
  const widths = [340, 170, 170], RH = 34, pad = 24, scale = 2
  const W = widths.reduce((a, b) => a + b) + pad * 2, H = pad * 2 + 40 + RH * (rows.length + 1)
  const c = document.createElement('canvas'); c.width = W * scale; c.height = H * scale
  const g = c.getContext('2d'); g.scale(scale, scale)
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H)
  g.fillStyle = '#111'; g.font = 'bold 18px Calibri, Arial, sans-serif'; g.fillText(title, pad, pad + 18)
  let y = pad + 40
  ;[head, ...rows].forEach((r, ri) => {
    let x = pad
    r.forEach((v, ci) => {
      if (ri === 0) { g.fillStyle = '#d3d3d3'; g.fillRect(x, y, widths[ci], RH) }
      g.strokeStyle = '#999'; g.strokeRect(x + 0.5, y + 0.5, widths[ci], RH)
      g.fillStyle = '#111'; g.font = `${ri === 0 ? 'bold ' : ''}14px Calibri, Arial, sans-serif`
      g.save(); g.beginPath(); g.rect(x, y, widths[ci] - 6, RH); g.clip(); g.fillText(String(v ?? ''), x + 8, y + 22); g.restore()
      x += widths[ci]
    })
    y += RH
  })
  return new Promise(res => c.toBlob(res, 'image/png'))
}

/** Make the file and hand it to the browser to save. */
export async function downloadTable(format, { title, head, rows, name }) {
  const T = (s, type) => new Blob([s], { type })
  const made = {
    pdf: () => [pdf(title, head, rows), 'pdf'],
    xls: () => [T(xls(head, rows), 'application/vnd.ms-excel'), 'xls'],
    xlsx: () => [xlsx(head, rows), 'xlsx'],
    rtf: () => [T(rtf(title, head, rows), 'application/rtf'), 'rtf'],
    docx: () => [docx(title, head, rows), 'docx'],
    mht: () => [T(mht(title, head, rows), 'message/rfc822'), 'mht'],
    html: () => [T(html(title, head, rows), 'text/html;charset=utf-8'), 'html'],
    txt: () => [T('\ufeff' + txt(head, rows), 'text/plain;charset=utf-8'), 'txt'],
    csv: () => [T(csv(head, rows), 'text/csv;charset=utf-8'), 'csv'],
    image: async () => [await image(title, head, rows), 'png'],
  }[format]
  if (!made) throw new Error('Unknown format ' + format)
  const [blob, ext] = await made()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `${name}.${ext}`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
