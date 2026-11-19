// A made-up passport data page (the ICAO specimen, Utopia, ERIKSSON ANNA MARIA)
// photographed the way an office phone does: 4000 px wide, a slight tilt, JPEG.
// Used by scripts/bench-speed.mjs; no real person's passport.
import sharp from 'sharp'
import path from 'path'
import { fileURLToPath } from 'url'
const out = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'sample-passport.jpg')
const W = 1250, H = 880
const l1 = 'P&lt;UTOERIKSSON&lt;&lt;ANNA&lt;MARIA&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;'
const l2 = 'L898902C36UTO7408122F1204159ZE184226B&lt;&lt;&lt;&lt;&lt;10'
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="100%" height="100%" fill="#e9efe6"/>
<rect x="40" y="150" width="300" height="380" fill="#b9b2a8"/>
<circle cx="190" cy="290" r="80" fill="#8d7f72"/>
<g font-family="Liberation Sans, Arial" fill="#333" font-size="20">
<text x="40" y="60" font-size="34" font-weight="bold">PASSPORT</text>
<text x="400" y="170">Surname</text><text x="400" y="200" font-size="28" fill="#000">ERIKSSON</text>
<text x="400" y="250">Given Names</text><text x="400" y="280" font-size="28" fill="#000">ANNA MARIA</text>
<text x="400" y="330">Date of Birth</text><text x="400" y="360" font-size="28" fill="#000">12 AUG 1974</text>
<text x="400" y="410">Place of Birth</text><text x="400" y="440" font-size="28" fill="#000">ADDIS ABABA</text>
<text x="800" y="410">Date of Issue</text><text x="800" y="440" font-size="28" fill="#000">16 APR 2007</text>
<text x="400" y="490">Date of Expiry</text><text x="400" y="520" font-size="28" fill="#000">15 APR 2012</text>
</g>
<g font-family="OCR-B, OCRB, Liberation Mono, DejaVu Sans Mono, monospace" font-size="39" fill="#111">
<text x="40" y="760" textLength="1170" lengthAdjust="spacingAndGlyphs">${l1}</text>
<text x="40" y="830" textLength="1170" lengthAdjust="spacingAndGlyphs">${l2}</text>
</g></svg>`
const page = await sharp(Buffer.from(svg)).resize({ width: 4000 }).png().toBuffer()
await sharp(page).rotate(1.2, { background: '#d0d0c8' }).extend({ top: 120, bottom: 120, left: 80, right: 80, background: '#5a5048' })
  .blur(1.2).jpeg({ quality: 88 }).toFile(out)
console.log(out)
