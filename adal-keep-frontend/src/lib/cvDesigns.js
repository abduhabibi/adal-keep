/**
 * New CV templates, coloured from two colours the person picks.
 *
 * A new template is made exactly like the hand-made agency templates (TAMKIN,
 * AL-WESAM, ASDAF, FURSTKUM, HADIYA, ABDAL, AL-SHAHD all share this page): the
 * same .cv-page markup — header picture, name and salary beside the photo,
 * the details table, the post and passport block above the full-body photo,
 * footer — so it goes through the same CV engine path (cvRender.mergeTemplate:
 * the same A4 fit, the same full-body framing, the same passport page 2, the
 * same preview and PDF). A design only changes colours and lines (CSS), never
 * the blocks or their sizes.
 *
 *   designHtml(id, primary, secondary) → { html, css }
 */

// ---------------------------------------------------------------- colours
const hex = (h) => { const m = String(h).replace('#', '').match(/^([0-9a-f]{6})$/i); const n = parseInt(m ? m[1] : '0f766e', 16); return [n >> 16 & 255, n >> 8 & 255, n & 255] }
const toHex = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t))
const lum = (h) => { const [r, g, b] = hex(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const ink = (bg) => (lum(bg) > 0.45 ? '#1f2937' : '#ffffff')

/** The palette: the two colours, their blend, soft tints and a deep shade. */
export function palette(p, s) {
  return {
    p, s,
    blend: mix(p, s, 0.5),
    deep: mix(p, '#000000', 0.35),
    pTint: mix(p, '#ffffff', 0.88),
    sTint: mix(s, '#ffffff', 0.85),
    soft: mix(mix(p, s, 0.5), '#ffffff', 0.93),
    line: mix(p, '#ffffff', 0.6),
    pInk: ink(p), sInk: ink(s), blendInk: ink(mix(p, s, 0.5)),
  }
}

// ---------------------------------------------------------------- the page
// The hand-made templates' page, as saved for TAMKIN (and six others), word for word.
export const SKELETON = `<div class="cv-page">
  <img class="cv-header" src="{{HEADER_IMAGE}}" alt="header" />

  <div class="cv-body">
    <table class="top-block">
      <tr>
        <td class="name-panel">
          <table class="inner">
            <tr>
              <td class="lbl">Full Name</td>
              <td class="val highlight">{{FULL_NAME}}</td>
              <td class="ar">الاسم الرباعي</td>
            </tr>
            <tr>
              <td class="lbl">Monthly Salary</td>
              <td class="val big">{{SALARY}} {{CURRENCY}}</td>
              <td class="ar">الراتب الشهري</td>
            </tr>
          </table>
        </td>
        <td class="headshot-cell">
          <img src="{{PHOTO_URL}}" alt="photo" />
        </td>
      </tr>
    </table>

    <div class="main-grid">
      <div class="left-col">
        <table class="details">
          <tr class="sec"><td colspan="3">Details of Applicant</td></tr>
          <tr><td class="lbl">Nationality</td><td class="val">{{NATIONALITY}}</td><td class="ar">الجنسية</td></tr>
          <tr><td class="lbl">Religion</td><td class="val">{{RELIGION}}</td><td class="ar">الديانة</td></tr>
          <tr><td class="lbl">Date Of Birth</td><td class="val">{{DOB}}</td><td class="ar">تاريخ الميلاد</td></tr>
          <tr><td class="lbl">Contact Number</td><td class="val">{{PHONE}}</td><td class="ar">رقم الاتصال</td></tr>
          <tr><td class="lbl">Place Of Birth</td><td class="val">{{PLACE_OF_BIRTH}}</td><td class="ar">مكان الميلاد</td></tr>
          <tr><td class="lbl">Living Town</td><td class="val">{{LIVING_TOWN}}</td><td class="ar">مكان السكن</td></tr>
          <tr><td class="lbl">Marital Status</td><td class="val">{{MARITAL_STATUS}}</td><td class="ar">الحالة الاجتماعية</td></tr>
          <tr><td class="lbl">No. of Children</td><td class="val">{{CHILDREN_COUNT}}</td><td class="ar">عدد الاطفال</td></tr>
          <tr><td class="lbl">Weight</td><td class="val">{{WEIGHT}}</td><td class="ar">الوزن</td></tr>
          <tr><td class="lbl">Height</td><td class="val">{{HEIGHT}}</td><td class="ar">الطول</td></tr>
          <tr><td class="lbl">Age</td><td class="val">{{AGE}}</td><td class="ar">العمر</td></tr>

          <tr class="sec"><td colspan="3">Skills &amp; Experience</td></tr>
          <tr><td class="lbl">CLEANING</td><td class="val skill">{{SKILL_CLEANING}}</td><td></td></tr>
          <tr><td class="lbl">IRONING</td><td class="val skill">{{SKILL_IRONING}}</td><td></td></tr>
          <tr><td class="lbl">WASHING</td><td class="val skill">{{SKILL_WASHING}}</td><td></td></tr>
          <tr><td class="lbl">BABY SITTING</td><td class="val skill">{{SKILL_BABY_SITTING}}</td><td></td></tr>
          <tr><td class="lbl">COOKING</td><td class="val skill">{{SKILL_COOKING}}</td><td></td></tr>

          <tr class="sec"><td colspan="3">Education &amp; Languages</td></tr>
          <tr><td class="lbl">ENGLISH</td><td class="val">{{ENGLISH}}</td><td></td></tr>
          <tr><td class="lbl">ARABIC</td><td class="val">{{ARABIC}}</td><td></td></tr>
          <tr><td class="lbl">OTHER</td><td class="val">NO</td><td></td></tr>
          <tr><td class="lbl">Education</td><td class="val">{{EDUCATION}}</td><td></td></tr>

          <tr class="sec"><td colspan="3">Employment Previous</td></tr>
          <tr><td class="lbl">Country</td><td class="val">{{PREV_COUNTRY}}</td><td class="ar">الخبرة خارج البلاد</td></tr>
          <tr><td class="lbl">Period</td><td class="val">{{PREV_PERIOD}}</td><td></td></tr>
        </table>
      </div>

      <div class="right-col">
        <table class="post">
          <tr><td class="lbl">Post Applied for</td><td class="val">{{POST_APPLIED}}</td></tr>
          <tr><td class="lbl">Contract Period</td><td class="val">{{CONTRACT_YEARS}}yrs</td></tr>
          <tr class="sec"><td colspan="2">Details Passport</td></tr>
          <tr><td class="lbl">Passport No.</td><td class="val">{{PASSPORT_NO}}</td></tr>
          <tr><td class="lbl">Date of Issue</td><td class="val">{{PASSPORT_ISSUE_DATE}}</td></tr>
          <tr><td class="lbl">Date of Expiry</td><td class="val">{{PASSPORT_EXPIRY_DATE}}</td></tr>
          <tr><td class="lbl">Place of Issue</td><td class="val">ETHIOPIA</td></tr>
        </table>
        <div class="body-photo">
          <img src="{{FULL_BODY_PHOTO_URL}}" alt="full body" />
        </div>
      </div>
    </div>
  </div>

  <img class="cv-footer" src="{{FOOTER_IMAGE}}" alt="footer" />
</div>`

// Their CSS with the two colours in place of TAMKIN's blues.
const baseCss = (c) => `
.cv-page{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#000;width:210mm;min-height:297mm;box-sizing:border-box;margin:0;padding:8px 16px;display:flex;flex-direction:column;background:#fff}
.cv-header,.cv-footer{display:block;width:100%;height:auto;margin:0;padding:0}
.cv-footer{margin-top:auto}
.cv-body{flex:1 1 auto;display:flex;flex-direction:column;gap:0;padding:0;margin:0;min-height:0}
.top-block{width:100%;border-collapse:collapse;margin:0 0 1.5mm 0;height:42mm}
.top-block>tbody>tr{height:42mm}
.top-block>tbody>tr>td{vertical-align:top;padding:0;border:0}
.name-panel{height:42mm;vertical-align:top}
.name-panel .inner{height:42mm;border-collapse:collapse;width:100%;table-layout:fixed}
.inner tr{height:50%}
.inner td{border:1px solid ${c.border};padding:4px 8px;vertical-align:middle;text-align:center}
.headshot-cell{width:32mm;padding-left:2mm!important;vertical-align:top}
.headshot-cell img{display:block;width:30mm;height:40mm;object-fit:cover;border:1px solid ${c.border}}
.main-grid{display:flex;gap:2mm;flex:1 1 auto;align-items:stretch;min-height:0;margin:0}
.left-col{flex:1 1 auto;display:flex;min-height:0}
.left-col .details{flex:1 1 auto;height:100%;border-collapse:collapse;width:100%;table-layout:fixed}
.right-col{width:62mm;flex:0 0 62mm;display:flex;flex-direction:column;gap:1.5mm;min-height:0}
.right-col .post{flex:0 0 auto;border-collapse:collapse;width:100%;table-layout:fixed}
.right-col .body-photo{flex:1 1 auto;min-height:120px;display:flex;border:1px solid ${c.border};overflow:hidden}
.right-col .body-photo img{width:100%;height:100%;object-fit:cover;display:block}
.details td,.post td,.inner td{border:1px solid ${c.border};padding:4px 7px;vertical-align:middle;font-size:9.5pt;text-align:center}
.details .lbl{width:32%;font-weight:bold}
.details .val{width:42%;font-size:10pt}
.details .ar{width:26%;font-size:9pt;direction:rtl}
.post .lbl{width:44%;font-weight:bold}
.post .val{width:56%;font-size:10pt}
.inner td:not(.val),.details td:not(.val),.post td:not(.val){background-color:${c.pTint}!important;color:${c.labelInk}}
.inner .val,.details .val,.post .val{background-color:#fff!important}
.details .sec>td,.post .sec>td{background-color:${c.secBg}!important;color:${c.secInk}!important;font-weight:bold;text-align:center!important;font-size:10pt}
.val.big{font-weight:bold;font-size:11pt}
.val.highlight{color:${c.accent}!important;font-weight:bold;font-size:12pt;text-transform:uppercase}
.skill{text-align:center;color:${c.tick};font-weight:bold;font-size:14pt}
.cv-header,.top-block{page-break-inside:avoid}
`

// ---------------------------------------------------------------- designs
// Each design: its colours for the page above, and a few lines of its own (CSS only).
const DESIGNS = {
  // TAMKIN's look: tinted labels, soft section bands.
  classic: (c) => ({ colors: {}, css: '' }),
  // The photos on the left: the headshot and the post/passport/full-body column swap sides.
  sidebar: (c) => ({
    colors: { secBg: c.p, secInk: c.pInk },
    css: `.top-block{direction:rtl}.top-block .inner,.top-block td{direction:ltr}.headshot-cell{padding-left:0!important;padding-right:2mm!important}
.main-grid{flex-direction:row-reverse}`,
  }),
  // Bold bands: solid main-colour section rows, second-colour name.
  ribbon: (c) => ({
    colors: { secBg: c.p, secInk: c.pInk, pTint: c.sTint, accent: c.p, tick: c.s },
    css: `.details .sec>td,.post .sec>td{letter-spacing:1px;text-transform:uppercase}
.inner td.val.highlight{border-bottom:3px solid ${c.s}}`,
  }),
  // Rounded corners on every block.
  cards: (c) => ({
    colors: {},
    css: `.inner,.details,.post{border-collapse:separate!important;border-spacing:0;border:1px solid ${c.border};border-radius:7px;overflow:hidden}
.inner td,.details td,.post td{border-width:0 1px 1px 0!important}
.right-col .body-photo,.headshot-cell img{border-radius:7px}`,
  }),
  // Fine lines: white labels with coloured words, thin rules.
  elegant: (c) => ({
    colors: { pTint: '#ffffff', labelInk: c.deep, secBg: '#ffffff', secInk: c.p, border: c.line, tick: c.s },
    css: `.details .sec>td,.post .sec>td{border-bottom:2px solid ${c.s}!important;letter-spacing:1.5px;font-variant:small-caps}`,
  }),
  // A main-to-second colour gradient on the section rows.
  diagonal: (c) => ({
    colors: { secInk: c.pInk, accent: c.s },
    css: `.details .sec>td,.post .sec>td{background:linear-gradient(100deg,${c.p},${c.blend} 70%,${c.s})!important}`,
  }),
}

export const DESIGN_LIST = [
  ['classic', 'Classic'], ['sidebar', 'Photos left'], ['ribbon', 'Bold bands'],
  ['cards', 'Rounded'], ['elegant', 'Fine lines'], ['diagonal', 'Gradient'],
]

/** Colour pairs that look good together (a start; any two colours work). */
export const COLOR_PAIRS = [
  ['#0f766e', '#f59e0b'], ['#1e3a8a', '#0ea5e9'], ['#7c2d12', '#d4a017'], ['#4c1d95', '#ec4899'],
  ['#14532d', '#84cc16'], ['#111827', '#c9a227'], ['#9f1239', '#f97316'], ['#0c4a6e', '#14b8a6'],
]

export function designHtml(id, primary, secondary) {
  const pal = palette(primary, secondary)
  const made = (DESIGNS[id] || DESIGNS.classic)(pal)
  const c = {
    ...pal, border: mix(pal.p, '#555555', 0.55), labelInk: '#000000',
    secBg: mix(pal.p, '#ffffff', 0.7), secInk: '#000000', accent: mix(pal.s, '#000000', 0.15), tick: pal.p,
    ...made.colors,
  }
  // The same page as the hand-made templates: the CV engine adds the passport page.
  return { html: SKELETON, css: baseCss(c) + made.css }
}
