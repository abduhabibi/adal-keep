/**
 * Ready-made CV designs, coloured from two colours the person picks.
 * Each design is the same kind of CV as the agency templates (English and
 * Arabic side by side, photo, full-body photo, passport details, languages
 * Speak / Read / Write, skills, previous work, mobile) — only the header
 * image is uploaded. The passport page is added by the CV engine itself
 * (cvRender.mergeTemplate), with its own title colour.
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

// ---------------------------------------------------------------- content
const PERSONAL = [
  ['Nationality', 'الجنسية', 'NATIONALITY'], ['Religion', 'الديانة', 'RELIGION'], ['Date of Birth', 'تاريخ الميلاد', 'DOB'],
  ['Age', 'العمر', 'AGE'], ['Place of Birth', 'مكان الميلاد', 'PLACE_OF_BIRTH'], ['Marital Status', 'الحالة الاجتماعية', 'MARITAL_STATUS'],
  ['No. of Children', 'عدد الأطفال', 'CHILDREN_COUNT'], ['Weight', 'الوزن', 'WEIGHT'], ['Height', 'الطول', 'HEIGHT'],
  ['Complexion', 'لون البشرة', 'COMPLEXION'], ['Education', 'المؤهل العلمي', 'EDUCATION'],
]
const PASSPORT = [
  ['Passport No.', 'رقم الجواز', 'PASSPORT_NO'], ['Date of Issue', 'تاريخ الإصدار', 'PASSPORT_ISSUE_DATE'],
  ['Date of Expiry', 'تاريخ الانتهاء', 'PASSPORT_EXPIRY_DATE'], ['Place of Issue', 'مكان الإصدار', '_ETHIOPIA'],
]
const JOB = [
  ['Post Applied', 'الوظيفة', 'POST_APPLIED'], ['Monthly Salary', 'الراتب الشهري', '_SALARY'],
  ['Contract Period', 'مدة العقد', '_YEARS'], ['Ref. No.', 'الرقم المرجعي', 'REF_NO'],
]
const SKILLS = [
  ['Cleaning', 'تنظيف', 'SKILL_CLEANING'], ['Washing', 'غسيل الملابس', 'SKILL_WASHING'], ['Ironing', 'كي الملابس', 'SKILL_IRONING'],
  ['Baby Sitting', 'رعاية الأطفال', 'SKILL_BABY_SITTING'], ['Cooking', 'طبخ', 'SKILL_COOKING'],
]
const tok = (k) => (k === '_ETHIOPIA' ? 'ETHIOPIA' : k === '_SALARY' ? '{{SALARY}} {{CURRENCY}}' : k === '_YEARS' ? '{{CONTRACT_YEARS}} YEARS' : `{{${k}}}`)

const photo = (cls) => `<div class="${cls}"><img src="{{PHOTO_URL}}" alt="" onerror="this.style.display='none'"></div>`
const body = (cls) => `<div class="${cls}"><img src="{{FULL_BODY_PHOTO_URL}}" alt="" onerror="this.style.display='none'"></div>`
const rows3 = (list) => list.map(([en, ar, k]) => `<tr><th>${en}</th><td>${tok(k)}</td><th class="ar">${ar}</th></tr>`).join('')
const langTable = () => `<table class="lang"><tr><th></th><th>Speak<span class="ar">محادثة</span></th><th>Read<span class="ar">قراءة</span></th><th>Write<span class="ar">كتابة</span></th></tr>
  <tr><th>English <span class="ar">الإنجليزية</span></th><td>{{ENGLISH_SPEAK}}</td><td>{{ENGLISH_READ}}</td><td>{{ENGLISH_WRITE}}</td></tr>
  <tr><th>Arabic <span class="ar">العربية</span></th><td>{{ARABIC_SPEAK}}</td><td>{{ARABIC_READ}}</td><td>{{ARABIC_WRITE}}</td></tr></table>`
const skillTable = () => `<table class="skills">${SKILLS.map(([en, ar, k]) => `<tr><th>${en}</th><td class="tick">{{${k}}}</td><th class="ar">${ar}</th></tr>`).join('')}</table>`
const prevTable = () => `<table class="kv"><tr><th>Country</th><td>{{PREV_COUNTRY}}</td><th class="ar">الدولة</th></tr><tr><th>Period</th><td>{{PREV_PERIOD}}</td><th class="ar">المدة</th></tr><tr><th>Position</th><td>{{PREV_POSITION}}</td><th class="ar">الوظيفة</th></tr></table>`
const title = (en, ar) => `<div class="sec"><span>${en}</span><span class="ar">${ar}</span></div>`

const BASE = `
*{box-sizing:border-box}
:root{color-scheme:light}
html,body{background:#fff!important;color:#1f2937}
body{font-family:Arial,Helvetica,sans-serif;margin:0}
.cv{width:210mm;padding:6mm 8mm 5mm;font-size:10.5px}
table{width:100%;border-collapse:collapse}
th,td{padding:3.6px 6px;text-align:left;vertical-align:middle;line-height:1.25}
th{font-weight:700}
.ar{direction:rtl;text-align:right;font-weight:600;font-family:'Arial',sans-serif}
td.tick{text-align:center;font-size:13px;font-weight:700}
.lang td{text-align:center;font-weight:700}
.lang tr:first-child th span.ar{display:block;font-size:9px;font-weight:600;text-align:center}
.lang tr+tr th span.ar{margin-left:5px;font-size:10px}
.skills th.ar,.kv th.ar{white-space:nowrap}
.ph img,.fb img{width:100%;height:100%;object-fit:cover;display:block}
.name{font-size:17px;font-weight:800;letter-spacing:.4px}
`

// ---------------------------------------------------------------- designs
const DESIGNS = {
  // 1. Classic grid: the agency layout, coloured bands and tinted labels.
  classic: (c) => ({
    html: `<div class="cv">
  <table class="top"><tr>
    <td class="jobs"><div class="namebar"><span>Name in Full</span><span class="ar">الاسم الكامل</span></div><div class="name nm">{{FULL_NAME}}</div>
      <table class="kv">${rows3(JOB)}</table></td>
    <td class="phcell">${photo('ph')}</td></tr></table>
  <table class="grid"><tr>
    <td class="col">${title('Details of Application', 'بيانات الطلب')}<table class="kv">${rows3(PERSONAL)}</table>
      ${title('Languages', 'إجادة اللغات')}${langTable()}</td>
    <td class="col">${title('Passport Details', 'بيانات جواز السفر')}<table class="kv">${rows3(PASSPORT)}</table>
      ${body('fb')}</td></tr></table>
  <table class="grid"><tr>
    <td class="col">${title('Skills & Experience', 'المهارات والخبرات')}${skillTable()}</td>
    <td class="col">${title('Previous Employment Abroad', 'الخبرة السابقة')}${prevTable()}
      <div class="mob">Mobile <b>{{PHONE}}</b> <span class="ar">رقم الجوال</span></div></td></tr></table>
</div>`,
    css: `${BASE}
.top>tbody>tr>td{vertical-align:top;padding:0}.top .jobs{padding-right:3mm}.phcell{width:38mm}
.ph{width:38mm;height:44mm;border:2px solid ${c.p};background:${c.soft}}
.kv th,.kv td,.lang th,.lang td,.skills th,.skills td{border:1px solid ${c.line}}
.kv th{background:${c.pTint};width:34%}.kv th.ar{width:26%;background:${c.sTint}}
.namebar{display:flex;justify-content:space-between;align-items:center;background:${c.p};color:${c.pInk};padding:4px 8px;font-weight:700}
.nm{border:1px solid ${c.line};border-top:0;padding:6px 8px;color:${c.deep};margin-bottom:1.5mm;text-align:center}
.grid{margin-top:2mm}.grid td.col{width:50%;vertical-align:top;padding:0}.grid td.col:first-child{padding-right:2mm}.grid td.col:last-child{padding-left:2mm}
.sec{display:flex;justify-content:space-between;background:${c.s};color:${c.sInk};padding:4px 8px;font-weight:700;margin-top:1.5mm}
.lang th{background:${c.pTint}}
.fb{height:66mm;margin-top:2mm;border:2px solid ${c.s};background:${c.soft}}
.mob{margin-top:2mm;padding:6px 8px;background:${c.sTint};border-left:4px solid ${c.p};display:flex;justify-content:space-between}
.mob b{color:${c.deep};font-size:12px}`,
  }),

  // 2. Sidebar: a coloured column with the photos, the details on the right.
  sidebar: (c) => ({
    html: `<div class="cv"><table class="wrap"><tr>
  <td class="side">${photo('ph')}
    <div class="sname">{{FULL_NAME}}</div><div class="post">{{POST_APPLIED}}</div>
    <div class="facts"><div><span>Salary</span><b>{{SALARY}} {{CURRENCY}}</b></div><div><span>Contract</span><b>{{CONTRACT_YEARS}} years</b></div><div><span>Ref.</span><b>{{REF_NO}}</b></div><div><span>Mobile</span><b>{{PHONE}}</b></div></div>
    ${body('fb')}</td>
  <td class="main">
    ${title('Personal Details', 'البيانات الشخصية')}<table class="kv">${rows3(PERSONAL)}</table>
    ${title('Passport', 'جواز السفر')}<table class="kv">${rows3(PASSPORT)}</table>
    ${title('Languages', 'اللغات')}${langTable()}
    <table class="two"><tr><td>${title('Skills', 'المهارات')}${skillTable()}</td><td>${title('Experience Abroad', 'الخبرة السابقة')}${prevTable()}</td></tr></table>
  </td></tr></table></div>`,
    css: `${BASE}
.cv{padding:5mm 7mm}
.wrap>tbody>tr>td{vertical-align:top;padding:0}
.side{width:58mm;background:linear-gradient(170deg,${c.p} 0%,${c.blend} 60%,${c.s} 100%);color:${c.pInk};padding:5mm 4mm!important;border-radius:4mm}
.ph{width:44mm;height:50mm;margin:0 auto;border:3px solid rgba(255,255,255,.85);border-radius:3mm;overflow:hidden;background:rgba(255,255,255,.25)}
.sname{text-align:center;font-weight:800;font-size:13.5px;margin-top:3mm;line-height:1.2}
.post{text-align:center;font-size:10px;opacity:.9;letter-spacing:1.5px;text-transform:uppercase;margin-top:1mm}
.facts{margin-top:3mm;border-top:1px solid rgba(255,255,255,.4)}
.facts div{display:flex;justify-content:space-between;padding:4px 1mm;border-bottom:1px solid rgba(255,255,255,.25)}.facts span{opacity:.85}
.fb{height:92mm;margin-top:4mm;border:3px solid rgba(255,255,255,.85);border-radius:3mm;overflow:hidden;background:rgba(255,255,255,.25)}
.main{padding-left:5mm!important}
.sec{display:flex;justify-content:space-between;color:${c.deep};border-bottom:2px solid ${c.s};padding:3px 1px;font-weight:800;font-size:11.5px;margin:2.2mm 0 1mm}
.sec .ar{color:${c.s}}
.kv tr:nth-child(odd){background:${c.soft}}.kv th{width:36%;color:${c.deep}}.kv th.ar{width:28%;color:#6b7280}
.lang th,.lang td{border-bottom:1px solid ${c.line}}.lang tr:first-child th{color:${c.deep}}
.skills tr:nth-child(odd){background:${c.soft}}.skills td.tick{color:${c.p}}
.two>tbody>tr>td{width:50%;vertical-align:top;padding:0}.two>tbody>tr>td:first-child{padding-right:2mm}.two>tbody>tr>td:last-child{padding-left:2mm}`,
  }),

  // 3. Ribbon: a bold name band and ribbon section titles.
  ribbon: (c) => ({
    html: `<div class="cv">
  <div class="band"><div><div class="name">{{FULL_NAME}}</div><div class="sub">{{POST_APPLIED}} · {{SALARY}} {{CURRENCY}} · {{CONTRACT_YEARS}} YEARS</div></div><div class="ref">REF<b>{{REF_NO}}</b></div></div>
  <table class="wrap"><tr>
    <td class="l">${title('Personal Details', 'البيانات الشخصية')}<table class="kv">${rows3(PERSONAL)}</table>
      ${title('Languages', 'اللغات')}${langTable()}
      ${title('Skills', 'المهارات')}${skillTable()}
      ${title('Experience Abroad', 'الخبرة السابقة')}${prevTable()}</td>
    <td class="r">${photo('ph')}
      ${title('Passport', 'جواز السفر')}<table class="kv">${rows3(PASSPORT)}</table>
      ${body('fb')}
      <div class="mob">📞 {{PHONE}}</div></td></tr></table></div>`,
    css: `${BASE}
.band{display:flex;justify-content:space-between;align-items:center;background:linear-gradient(90deg,${c.p},${c.blend});color:${c.pInk};padding:4mm 6mm;border-radius:2mm;box-shadow:inset 0 -4px 0 ${c.s}}
.band .name{font-size:19px}.band .sub{font-size:10.5px;opacity:.92;margin-top:1mm;letter-spacing:.6px}
.ref{text-align:right;font-size:9px;letter-spacing:2px}.ref b{display:block;font-size:13px;letter-spacing:.5px}
.wrap{margin-top:2mm}.wrap>tbody>tr>td{vertical-align:top;padding:0}.l{width:57%;padding-right:3mm!important}.r{width:43%}
.sec{position:relative;display:flex;justify-content:space-between;background:${c.s};color:${c.sInk};padding:4px 9px 4px 11px;font-weight:800;margin:2.5mm 0 1.2mm;clip-path:polygon(0 0,100% 0,97% 50%,100% 100%,0 100%)}
.sec:before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:${c.p}}
.sec .ar{padding-right:5mm}
.kv th,.kv td,.skills th,.skills td,.lang th,.lang td{border-bottom:1px dashed ${c.line}}
.kv th{width:37%;color:${c.deep}}.kv th.ar{width:28%;color:${c.s}}
.ph{width:42mm;height:48mm;margin:0 auto;border-radius:50% 50% 3mm 3mm;overflow:hidden;border:3px solid ${c.p};background:${c.soft}}
.fb{height:96mm;margin-top:2.5mm;border:2px solid ${c.s};border-radius:2mm;overflow:hidden;background:${c.soft}}
.mob{margin-top:2mm;text-align:center;font-weight:800;font-size:13px;color:${c.deep};background:${c.sTint};padding:5px;border-radius:2mm}
.skills td.tick{color:${c.p}}`,
  }),

  // 4. Cards: soft rounded cards, chips for the job facts.
  cards: (c) => ({
    html: `<div class="cv">
  <table class="hero"><tr><td class="phc">${photo('ph')}</td>
    <td><div class="name">{{FULL_NAME}}</div><div class="ar arname">الاسم الكامل</div>
      <div class="chips"><span>{{POST_APPLIED}}</span><span>{{SALARY}} {{CURRENCY}}</span><span>{{CONTRACT_YEARS}} years</span><span>Ref {{REF_NO}}</span><span>📞 {{PHONE}}</span></div></td></tr></table>
  <table class="grid"><tr>
    <td><div class="card">${title('Personal Details', 'البيانات الشخصية')}<table class="kv">${rows3(PERSONAL)}</table></div>
        <div class="card">${title('Languages', 'اللغات')}${langTable()}</div></td>
    <td><div class="card">${title('Passport', 'جواز السفر')}<table class="kv">${rows3(PASSPORT)}</table></div>
        <div class="card fbc">${body('fb')}</div></td></tr>
  <tr><td><div class="card">${title('Skills', 'المهارات')}${skillTable()}</div></td>
      <td><div class="card">${title('Experience Abroad', 'الخبرة السابقة')}${prevTable()}</div></td></tr></table></div>`,
    css: `${BASE}
.cv{background:${c.soft}}
.hero{background:#fff;border-radius:4mm;box-shadow:0 1px 0 ${c.line}}.hero>tbody>tr>td{vertical-align:middle;padding:3mm}
.phc{width:40mm}.ph{width:36mm;height:42mm;border-radius:3mm;overflow:hidden;background:${c.pTint};border:3px solid ${c.p}}
.name{font-size:20px;color:${c.deep}}.arname{color:${c.s};font-size:10px;text-align:left}
.chips{margin-top:2.5mm;display:flex;flex-wrap:wrap;gap:4px}.chips span{background:${c.p};color:${c.pInk};padding:3px 9px;border-radius:99px;font-weight:700;font-size:10px}
.chips span:nth-child(even){background:${c.s};color:${c.sInk}}
.grid{border-collapse:separate;border-spacing:2.5mm;margin:0 -2.5mm}.grid>tbody>tr>td{width:50%;vertical-align:top;padding:0}
.card{background:#fff;border-radius:3mm;padding:2mm 3mm;margin-bottom:2.5mm;border-top:3px solid ${c.s}}
.sec{display:flex;justify-content:space-between;color:${c.p};font-weight:800;font-size:11.5px;padding-bottom:1.5mm}.sec .ar{color:${c.s}}
.kv th{width:38%;color:#374151}.kv th.ar{width:28%;color:#9ca3af}.kv tr+tr th,.kv tr+tr td{border-top:1px solid ${c.soft}}
.lang tr:first-child th{color:${c.p}}.lang td{color:${c.deep}}
.skills td.tick{color:${c.s}}
.fbc{padding:2mm}.fb{height:66mm;border-radius:2mm;overflow:hidden;background:${c.pTint}}`,
  }),

  // 5. Elegant: white, fine coloured rules, small-caps headings.
  elegant: (c) => ({
    html: `<div class="cv">
  <div class="head"><div class="name">{{FULL_NAME}}</div><div class="rule"></div>
    <div class="meta"><span>{{POST_APPLIED}}</span>•<span>{{SALARY}} {{CURRENCY}}</span>•<span>{{CONTRACT_YEARS}} YEARS</span>•<span>REF {{REF_NO}}</span>•<span>{{PHONE}}</span></div></div>
  <table class="wrap"><tr>
    <td class="l">${photo('ph')}${body('fb')}</td>
    <td class="r">${title('Personal Details', 'البيانات الشخصية')}<table class="kv">${rows3(PERSONAL)}</table>
      ${title('Passport', 'جواز السفر')}<table class="kv">${rows3(PASSPORT)}</table>
      ${title('Languages', 'اللغات')}${langTable()}
      <table class="two"><tr><td>${title('Skills', 'المهارات')}${skillTable()}</td><td>${title('Experience Abroad', 'الخبرة السابقة')}${prevTable()}</td></tr></table></td></tr></table></div>`,
    css: `${BASE}
.head{text-align:center}.name{font-size:21px;color:${c.deep};letter-spacing:2px}
.rule{height:3px;width:60mm;margin:2mm auto;background:linear-gradient(90deg,transparent,${c.p},${c.s},transparent)}
.meta{font-size:10px;color:#4b5563;letter-spacing:.8px}.meta span{margin:0 4px;font-weight:700;color:${c.p}}
.wrap{margin-top:3mm}.wrap>tbody>tr>td{vertical-align:top;padding:0}.l{width:50mm;padding-right:5mm!important}
.ph{height:54mm;border:1px solid ${c.p};padding:1.5mm;background:#fff}.ph img{border:1px solid ${c.line}}
.fb{height:120mm;margin-top:3mm;border:1px solid ${c.s};padding:1.5mm;background:#fff}
.sec{display:flex;justify-content:space-between;font-variant:small-caps;letter-spacing:1.5px;color:${c.p};font-weight:800;font-size:12px;border-bottom:1px solid ${c.s};padding:2px 0;margin:2.2mm 0 1mm}
.sec .ar{color:${c.s};letter-spacing:0;font-variant:normal}
.kv th{width:36%;font-weight:600;color:#6b7280}.kv td{font-weight:700}.kv th.ar{width:28%;color:#9ca3af}
.kv tr+tr th,.kv tr+tr td{border-top:1px dotted ${c.line}}
.lang th,.lang td{border-bottom:1px dotted ${c.line}}.lang td{color:${c.deep}}
.skills td.tick{color:${c.s}}.skills tr+tr th,.skills tr+tr td{border-top:1px dotted ${c.line}}
.two>tbody>tr>td{width:50%;vertical-align:top;padding:0}.two>tbody>tr>td:first-child{padding-right:2mm}.two>tbody>tr>td:last-child{padding-left:2mm}`,
  }),

  // 6. Diagonal: a split colour top with tiles, then two columns.
  diagonal: (c) => ({
    html: `<div class="cv">
  <div class="top"><div class="t1">${photo('ph')}</div>
    <div class="t2"><div class="name">{{FULL_NAME}}</div>
      <div class="tiles"><div><span>Post</span><b>{{POST_APPLIED}}</b></div><div><span>Salary</span><b>{{SALARY}} {{CURRENCY}}</b></div><div><span>Contract</span><b>{{CONTRACT_YEARS}} yrs</b></div><div><span>Age</span><b>{{AGE}}</b></div><div><span>Religion</span><b>{{RELIGION}}</b></div><div><span>Mobile</span><b>{{PHONE}}</b></div></div></div></div>
  <table class="wrap"><tr>
    <td class="l">${title('Personal Details', 'البيانات الشخصية')}<table class="kv">${rows3(PERSONAL)}</table>
      ${title('Skills', 'المهارات')}${skillTable()}</td>
    <td class="r">${title('Passport', 'جواز السفر')}<table class="kv">${rows3(PASSPORT)}</table>
      ${title('Languages', 'اللغات')}${langTable()}
      ${title('Experience Abroad', 'الخبرة السابقة')}${prevTable()}
      ${body('fb')}</td></tr></table>
  <div class="foot">Ref. {{REF_NO}} <span class="ar">الرقم المرجعي</span></div></div>`,
    css: `${BASE}
.top{display:flex;align-items:stretch;border-radius:3mm;overflow:hidden;background:linear-gradient(115deg,${c.p} 0%,${c.p} 38%,${c.s} 38.2%,${c.blend} 100%)}
.t1{padding:3mm 4mm}.ph{width:36mm;height:42mm;border:3px solid #fff;border-radius:2mm;overflow:hidden;background:rgba(255,255,255,.3)}
.t2{flex:1;padding:3mm 5mm;color:${c.sInk}}.name{font-size:18px;text-shadow:0 1px 1px rgba(0,0,0,.15)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:2mm;margin-top:2.5mm}
.tiles div{background:rgba(255,255,255,.92);color:#1f2937;border-radius:2mm;padding:2mm;text-align:center}
.tiles span{display:block;font-size:8.5px;color:${c.s};text-transform:uppercase;letter-spacing:1px}.tiles b{color:${c.deep};font-size:11px}
.wrap{margin-top:2mm}.wrap>tbody>tr>td{vertical-align:top;padding:0;width:50%}.l{padding-right:2.5mm!important}.r{padding-left:2.5mm!important}
.sec{display:flex;justify-content:space-between;color:${c.pInk};background:${c.p};border-radius:99px;padding:3px 10px;font-weight:800;margin:2.4mm 0 1.2mm}
.sec .ar{opacity:.9}
.kv th,.kv td,.skills th,.skills td,.lang th,.lang td{border-bottom:1px solid ${c.soft}}
.kv th{width:37%;color:${c.deep}}.kv th.ar{width:28%;color:${c.s}}
.lang tr:first-child th{color:${c.s}}.skills td.tick{color:${c.s}}
.fb{height:58mm;margin-top:2.5mm;border-radius:3mm;overflow:hidden;border:2px solid ${c.s};background:${c.soft}}
.foot{margin-top:2mm;display:flex;justify-content:space-between;font-size:9.5px;color:#6b7280;border-top:2px solid ${c.s};padding-top:1.5mm}`,
  }),
}

export const DESIGN_LIST = [
  ['classic', 'Classic grid'], ['sidebar', 'Sidebar'], ['ribbon', 'Ribbon'],
  ['cards', 'Soft cards'], ['elegant', 'Elegant'], ['diagonal', 'Diagonal'],
]

/** Colour pairs that look good together (a start; any two colours work). */
export const COLOR_PAIRS = [
  ['#0f766e', '#f59e0b'], ['#1e3a8a', '#0ea5e9'], ['#7c2d12', '#d4a017'], ['#4c1d95', '#ec4899'],
  ['#14532d', '#84cc16'], ['#111827', '#c9a227'], ['#9f1239', '#f97316'], ['#0c4a6e', '#14b8a6'],
]

export function designHtml(id, primary, secondary) {
  const make = DESIGNS[id] || DESIGNS.classic
  const { html, css } = make(palette(primary, secondary))
  // A whole page: the CV engine puts the header above it (inside <body>).
  return { html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`, css }
}
