/**
 * A CV drawn on this device (the phone with the office PC off): the same page
 * the PC draws (backend services/cvRender.js buildTemplateData + mergeTemplate,
 * routes/cv.js withEdits), from the phone's own copy of her profile, her
 * pictures and the template. The PC's page code is copied here word for word;
 * the backend test tests/cvLocal.test.js checks the two still give the same
 * page. Asked on 2026-11-15: CVs open and download with the PC off.
 */

// Her father's name as the emergency contact: his name and his father's (her surname),
// e.g. "ABAGOLE KEDIR". A saved name that was only his first name gets the surname too.
function fatherFull(p = {}) {
  const base = String(p.father_name || p.middle_name || '').trim()
  const sur = String(p.last_name || '').trim()
  if (!base) return ''
  return sur && !base.toUpperCase().split(/\s+/).includes(sur.toUpperCase()) ? `${base} ${sur}` : base
}
function emergencyName(p = {}) {
  const e = String(p.emergency_name || '').trim()
  const bare = [p.father_name, p.middle_name].map(x => String(x || '').trim().toUpperCase()).filter(Boolean)
  return (!e || bare.includes(e.toUpperCase())) ? fatherFull(p) || e : e
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)))
function placeholderSvg(label, w = 200, h = 250) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#e5e7eb"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#9ca3af">${label}</text></svg>`
  return 'data:image/svg+xml;base64,' + b64(svg)
}
export const DEFAULT_SKILLS = { cleaning: true, ironing: true, washing: true, baby_sitting: true }
export const PHOTO_PH = placeholderSvg('No photo')
export const BODY_PH = placeholderSvg('No full-body photo', 200, 400)

function computeAge(dob) {
  if (!dob) return ''
  const d = new Date(dob)
  if (isNaN(d)) return ''
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--
  return String(age)
}
function formatDate(d) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt)) return d
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  return `${String(dt.getDate()).padStart(2, '0')} ${months[dt.getMonth()]} ${dt.getFullYear()}`
}

// ---- backend services/contractFields.js fieldsFromContract
const cDate = (v) => {
  const s = String(v || '').trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null
}
const cText = (v) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() && !/^(-|n\/a|null|undefined)$/i.test(String(v).trim()) ? String(v).trim() : null
const CONTRACT_MAP = [
  ['date_of_birth', ['Date of Birth'], cDate],
  ['passport_issue_date', ['Passport Issue Date'], cDate],
  ['passport_expiry_date', ['Passport Expiry Date'], cDate],
  ['gender', ['Gender'], cText],
  ['marital_status', ['Marital Status'], cText],
  ['religion', ['Religion'], cText],
  ['education_level', ['Education level', 'Education Level'], cText],
  ['children_count', ['Number Of Children', 'Number of Children'], (v) => (/^\d{1,2}$/.test(String(v).trim()) ? Number(v) : null)],
  ['place_of_birth', ['City', 'Address'], cText],
  ['living_town', ['City', 'Address'], cText],
  ['phone_number', ['Candidate · Mobile Number'], cText],
  ['first_name', ['Given Names'], cText],
  ['last_name', ['Surname'], cText],
  ['emergency_name', ['Relative name'], cText],
  ['emergency_phone', ['Relative phone'], cText],
  ['emergency_relationship', ['Relative kinship'], cText],
]
export function fieldsFromContract(profile) {
  let c = profile?.contract_data
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  if (!c || typeof c !== 'object') return {}
  const out = {}
  for (const [col, labels, read] of CONTRACT_MAP) {
    const had = profile[col]
    if (had != null && String(had).trim() !== '') continue
    for (const l of labels) {
      const v = read(c[l])
      if (v != null && v !== '') { out[col] = v; break }
    }
  }
  return out
}

// ---- backend services/bodySize.js withBodySize (sha256 here is WebCrypto's: async)
const unsetSize = (v) => !String(v ?? '').trim() || /^(normal|-+|n\/?a|none)$/i.test(String(v).trim())
async function spread(key, salt) {
  const h = new DataView(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${key}`)))
  return h.getUint32(0) % 10 + (1 + h.getUint32(4) % 9) / 10
}
export async function withBodySize(p) {
  const key = String(p?.passport_number || p?.id || p?.full_name || '').trim().toUpperCase()
  return {
    ...p,
    height: unsetSize(p.height) ? (155 + await spread(key, 'height')).toFixed(1) : p.height,
    weight: unsetSize(p.weight) ? (55 + await spread(key, 'weight')).toFixed(1) : p.weight,
  }
}

/**
 * The template's words, as the PC's buildTemplateData makes them. imgs: the
 * pictures as data: links ({ photo, fullBody, passport, header, footer }).
 */
export async function cvData(profile, template, overrides = {}, imgs = {}, brokerPhone = '') {
  const photoUrl = imgs.photo || PHOTO_PH
  const fullBodyUrl = imgs.fullBody || BODY_PH
  const passportUrl = imgs.passport || ''
  const headerUrl = imgs.header || ''
  const footerUrl = imgs.footer || ''
  const merged = { ...profile, ...fieldsFromContract(profile), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== '' && v != null)) }
  const parse = (v, fallback) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback) } catch { return fallback } }

  let skills = parse(overrides.skills, null) || parse(profile.skills, null)
  if (!skills || !Object.values(skills).some(Boolean)) skills = { ...DEFAULT_SKILLS }
  const cookingLevel = merged.cooking_skill && merged.cooking_skill !== 'None' ? merged.cooking_skill : ''
  if (cookingLevel) skills = { ...skills, cooking: true }

  let prev = parse(overrides.previous_employment, null) || parse(profile.previous_employment, []) || []
  if (!prev.length && /^have/i.test(merged.work_experience || '') && merged.experience_country) {
    prev = [{ country: merged.experience_country, years: merged.experience_years }]
  }
  const prev0 = prev[0] || {}
  const prevPeriod = prev0.period ||
    (prev0.from || prev0.to ? [prev0.from, prev0.to].filter(Boolean).map(d => String(d).slice(0, 4)).join(' – ') : '') ||
    (prev0.years ? `${prev0.years} year${Number(prev0.years) === 1 ? '' : 's'}` : '')

  if (!merged.phone_number && brokerPhone) merged.phone_number = brokerPhone
  if (!merged.living_town) merged.living_town = merged.zone_subcity || merged.region || merged.place_of_birth || ''
  Object.assign(merged, await withBodySize(merged))

  const skillLabels = { cleaning: 'cleaning', ironing: 'ironing', washing: 'washing', baby_sitting: 'baby sitting', cooking: (cookingLevel || 'cooking').toLowerCase() }
  const checked = Object.keys(skillLabels).filter(k => skills[k]).map(k => skillLabels[k])
  const remarks = !checked.length ? ''
    : checked.length === 1 ? `She can do ${checked[0]}.`
    : `She can do ${checked.slice(0, -1).join(', ')} and ${checked[checked.length - 1]}.`

  return {
    REMARKS:         merged.remarks || remarks,
    FULL_NAME:        merged.full_name || '',
    GIVEN_NAMES:      merged.first_name || merged.given_names || '',
    SURNAME:          merged.last_name  || '',
    NATIONALITY:      merged.nationality || 'ETHIOPIAN',
    SEX:              merged.gender || merged.sex || '',
    DOB:              formatDate(merged.date_of_birth),
    AGE:              computeAge(merged.date_of_birth),
    PASSPORT_NO:      merged.passport_number || '',
    PASSPORT_ISSUE_DATE:  formatDate(merged.passport_issue_date),
    PASSPORT_EXPIRY_DATE: formatDate(merged.passport_expiry_date),
    PLACE_OF_BIRTH:   merged.place_of_birth || '',
    RELIGION:         merged.religion || '',
    MARITAL_STATUS:   merged.marital_status || 'SINGLE',
    CHILDREN_COUNT:   merged.children_count == null || merged.children_count === '' ? 'None' : String(merged.children_count),
    WEIGHT:           merged.weight,
    HEIGHT:           merged.height,
    COMPLEXION:       merged.complexion || '',
    LIVING_TOWN:      merged.living_town || '',
    MOTHER_NAME:      merged.mother_name || '',
    FATHER_NAME:      merged.father_name || '',
    SPOUSE_NAME:      merged.spouse_name || '',
    PHONE:            merged.phone_number || '',
    EDUCATION:        (merged.education_level && !/^new$/i.test(String(merged.education_level).trim())) ? merged.education_level : 'Preparatory',
    ENGLISH:          languageText(merged, 'english'),
    ARABIC:           languageText(merged, 'arabic'),
    ENGLISH_SPEAK:    yes(merged.speaks_english),
    ENGLISH_READ:     yes(merged.english_read),
    ENGLISH_WRITE:    yes(merged.english_write),
    ARABIC_SPEAK:     yes(merged.speaks_arabic),
    ARABIC_READ:      yes(merged.arabic_read),
    ARABIC_WRITE:     yes(merged.arabic_write),
    POST_APPLIED:     overrides.post_applied || 'HOUSE MAID',
    SALARY:           String(overrides.salary ?? template.salary ?? ''),
    CURRENCY:         overrides.currency || template.currency || 'SAR',
    COUNTRY:          overrides.country || template.country || '',
    CONTRACT_YEARS:   String(overrides.contract_years || template.contract_years || 2),
    REF_NO:           overrides.ref_no || '',
    DATE_TODAY:       new Date().toISOString().slice(0, 10),
    SKILL_CLEANING:      skills.cleaning     ? '✓' : '',
    SKILL_IRONING:       skills.ironing      ? '✓' : '',
    SKILL_WASHING:       skills.washing      ? '✓' : '',
    SKILL_BABY_SITTING:  skills.baby_sitting ? '✓' : '',
    SKILL_COOKING:       skills.cooking      ? '✓' : '',
    PREV_COUNTRY:     prev0.country  || '-',
    PREV_PERIOD:      prevPeriod     || '-',
    PREV_POSITION:    prev0.position || '-',
    PHOTO_URL:        photoUrl,
    FULL_BODY_PHOTO_URL: fullBodyUrl,
    FULL_BODY_BOX:    '',   // the PC finds her box itself (cvRender bodyBoxOf); here the page does
    PASSPORT_URL:     passportUrl,
    HEADER_IMAGE:     headerUrl,
    FOOTER_IMAGE:     footerUrl,
    LOGO_URL:         '',
    LABOR_ID:         merged.labor_id || '',
    PERSONAL_NUMBER:  merged.personal_number || '',
    REGION:           merged.region || '',
    ZONE_SUBCITY:     merged.zone_subcity || '',
    EMERGENCY_NAME:   emergencyName(merged),
    EMERGENCY_PHONE:  merged.emergency_phone || '',
    EMERGENCY_GENDER: merged.emergency_gender || 'Male',
    EMERGENCY_RELATIONSHIP: merged.emergency_relationship || 'Father',
    COOKING_SKILL:    merged.cooking_skill || 'None',
    PASSPORT_PAGE_INCLUDE:        !!template.include_passport && template.include_passport !== 0 && template.include_passport !== '0',
    PASSPORT_PAGE_INCLUDE_HEADER: template.passport_include_header !== false,
    PASSPORT_PAGE_INCLUDE_FOOTER: template.passport_include_footer !== false,
    PASSPORT_PAGE_H1:             (template.passport_h1 || '').trim(),
    PASSPORT_PAGE_H1_COLOR:       template.passport_h1_color || '#000000',
  }
}

// ---- backend services/cvRender.js, word for word (languages, page, merge)

const on = (v) => v === true || v === 1 || v === '1' || v === 'true'
const yes = (v) => (on(v) ? 'YES' : 'NO')
function languageText(p, lang) {
  const can = [on(lang === 'english' ? p.speaks_english : p.speaks_arabic) && 'SPEAK', on(p[`${lang}_read`]) && 'READ', on(p[`${lang}_write`]) && 'WRITE'].filter(Boolean)
  return can.length ? can.join(', ') : 'NO'
}

/**
 * Templates made before Speak / Read / Write were separate show {{ENGLISH}}
 * and {{ARABIC}} in their language grids. Each cell gets its own:
 *   - a row labelled Read / Write / Speak (قراءة / كتابة / محادثة): its
 *     {{ENGLISH}} / {{ARABIC}} — or its fixed YES / NO cells, English first —
 *     become that row's ENGLISH_READ … ARABIC_WRITE;
 *   - a row with {{ENGLISH}} (or {{ARABIC}}) several times under a header
 *     row SPEAK · READ · WRITE: each takes its column's.
 * Other {{ENGLISH}} / {{ARABIC}} stay one cell ("SPEAK, READ").
 */
export function splitLanguageCells(html) {
  const SKILL = { read: 'READ', write: 'WRITE', speak: 'SPEAK', 'قراءة': 'READ', 'كتابة': 'WRITE', 'محادثة': 'SPEAK' }
  const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
  let order = null
  return String(html || '').replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (row) => {
    const cells = row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || []
    const words = cells.map(c => text(c).toLowerCase())
    // a header row: SPEAK READ WRITE in some order
    const heads = words.map(w => (/^(speak|read|write)\b/.test(w) ? w.match(/^(speak|read|write)/)[1].toUpperCase() : null))
    if (heads.filter(Boolean).length >= 2 && !/\{\{/.test(row)) { order = heads.filter(Boolean); return row }
    // a row labelled with one skill
    const first = (words[0] || '').split(' ')
    const skill = SKILL[first[0]] || SKILL[first[first.length - 1]]
    if (skill && cells.length >= 2) {
      let langs = ['ENGLISH', 'ARABIC'], i = 0
      return row.replace(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi, (cell, off) => {
        if (i++ === 0) return cell
        if (/\{\{(ENGLISH|ARABIC)\}\}/.test(cell)) return cell.replace(/\{\{(ENGLISH|ARABIC)\}\}/g, (_, l) => { langs = langs.filter(x => x !== l); return `{{${l}_${skill}}}` })
        if (/^(yes|no)$/i.test(text(cell)) && langs.length) { const l = langs.shift(); return cell.replace(/>(\s*)(yes|no)(\s*)</i, `>$1{{${l}_${skill}}}$3<`) }
        return cell
      })
    }
    // repeated cells under the header
    if (order) {
      let changed = row
      for (const l of ['ENGLISH', 'ARABIC']) {
        const re = new RegExp(`\\{\\{${l}\\}\\}`, 'g')
        if ((row.match(re) || []).length === order.length) { let k = 0; changed = changed.replace(re, () => `{{${l}_${order[k++]}}}`) }
      }
      return changed
    }
    return row
  })
}

// The CV page is one A4 in the preview and in the PDF alike. The full-body
// photo fills its box without pushing the page taller (it takes the room left
// beside the table, whole: a photo often holds the face as well).
const PAGE_CSS = `
body{background:#fff!important;}
.cv-page{width:210mm!important;min-height:297mm!important;margin:0 auto!important;box-shadow:none!important;flex:none;}
.main-grid{align-items:stretch;}
.right-col{display:flex;flex-direction:column;}
.body-photo{position:relative;flex:1 1 auto;min-height:50mm;padding:0!important;overflow:hidden;background:#fff;}
.body-photo img{position:absolute;left:0;top:0;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;object-fit:contain!important;}
/* Her photos are never cut: every picture on the CV shows whole in its box (asked on 2026-11-13). */
img{object-fit:contain!important;object-position:center!important;}
/* A design (.cv): the photos fill their frames, edge to edge (asked on 2026-11-18). */
.cv .ph img,.cv .fb img{width:100%!important;height:100%!important;object-fit:cover!important;object-position:center top!important;}
.cv{margin:0 auto;}
`
// Templates whose photos were capped small (Al-Shahd and those made like it).
const WIDE_PHOTOS_CSS = `
.cv-body{display:flex;flex-direction:column;}
.main-grid{flex:1 1 auto;}
.left-col{flex:1 1 0;min-width:0;display:flex;}
.left-col .details{height:100%;}
.right-col{flex:0 0 62mm;}
.name-panel .inner{height:36mm;}
.headshot-cell{width:34mm;padding:0!important;}
.headshot-cell img{display:block;width:100%;max-width:none;height:40mm;object-fit:contain;object-position:center;background:#fff;border:0;}
`
// Runs in the preview and before the PDF, so both show the same page. A CV too
// tall for A4 first loses cell padding, then shrinks its body; one that fits is
// left alone.
const FIT_SCRIPT = `<script>(function(){
function personBox(img){
  // Found already on the PC (data-adal-box: x0,y0,x1,y1,w,h of this very picture, or none).
  var a=img.getAttribute('data-adal-box');
  if(a==='none')return null;
  if(a){var v=a.split(',').map(Number);if(v.length===6&&v.every(isFinite)&&v[4]===img.naturalWidth&&v[5]===img.naturalHeight)return {x0:v[0],y0:v[1],x1:v[2],y1:v[3],w:v[4],h:v[5]}}
  // Where she stands in the picture (natural px): the pixels that differ from the
  // background, which is read row by row from the left and right edges (a wall and
  // a floor of different colours both work). null when it cannot tell.
  var nw=img.naturalWidth,nh=img.naturalHeight;if(!nw||!nh)return null;
  var k=Math.min(1,160/Math.max(nw,nh)),w=Math.max(8,Math.round(nw*k)),h=Math.max(8,Math.round(nh*k));
  var c=document.createElement('canvas');c.width=w;c.height=h;var x=c.getContext('2d',{willReadFrequently:true});
  try{x.drawImage(img,0,0,w,h);var d=x.getImageData(0,0,w,h).data}catch(e){return null}
  return adalBoxOf(d,w,h,k,nw,nh);
}
function adalBoxOf(d,w,h,k,nw,nh){
  var s=Math.max(2,Math.round(w*0.04)),L=[],R=[],y,i,o,j;
  for(y=0;y<h;y++){var l=[0,0,0],r=[0,0,0],n=0;
    for(j=Math.max(0,y-2);j<=Math.min(h-1,y+2);j++)for(i=0;i<s;i++){o=(j*w+i)*4;l[0]+=d[o];l[1]+=d[o+1];l[2]+=d[o+2];o=(j*w+w-1-i)*4;r[0]+=d[o];r[1]+=d[o+1];r[2]+=d[o+2];n++}
    L.push([l[0]/n,l[1]/n,l[2]/n]);R.push([r[0]/n,r[1]/n,r[2]/n])}
  // her pixels differ from both edges of their row (a wall, a floor, a backdrop's dark edge)
  var dist=function(o,a){var dr=d[o]-a[0],dg=d[o+1]-a[1],db=d[o+2]-a[2];return Math.sqrt(dr*dr+dg*dg+db*db)};
  var T=[];for(y=0;y<h;y++){var nz=0,m=0;for(j=Math.max(0,y-2);j<=Math.min(h-1,y+2);j++)for(i=0;i<s;i++){nz+=dist((j*w+i)*4,L[y])+dist((j*w+w-1-i)*4,R[y]);m+=2}T.push(Math.max(28,2.5*nz/m+12))}
  var col=[],fg=new Uint8Array(w*h),all=0;for(i=0;i<w;i++)col.push(0);
  for(y=0;y<h;y++)for(i=s;i<w-s;i++){o=(y*w+i)*4;if(Math.min(dist(o,L[y]),dist(o,R[y]))>T[y]){fg[y*w+i]=1;col[i]++;all++}}
  var best=0;for(i=1;i<w;i++)if(col[i]>col[best])best=i;
  if(col[best]<h*0.25)return null;
  // every column with much of her in it stays (a shadow beside her may widen the box: never narrower)
  var min=Math.max(h*0.08,col[best]*0.3),x0=-1,x1=-1;
  for(i=0;i<w;i++)if(col[i]>min){if(x0<0)x0=i;x1=i}
  var rowOn=function(y){var n=0;for(var i=x0;i<=x1;i++)n+=fg[y*w+i];return n>Math.max(1,(x1-x0+1)*0.04)};
  var y0=0,y1=h-1;
  for(y=0;y<h-2;y++)if(rowOn(y)&&rowOn(y+1)&&rowOn(y+2)){y0=y;break}
  for(y=h-1;y>1;y--)if(rowOn(y)&&rowOn(y-1)&&rowOn(y-2)){y1=y;break}
  var inBox=0;for(y=y0;y<=y1;y++)for(i=x0;i<=x1;i++)inBox+=fg[y*w+i];
  if(inBox<all*0.85)return null;
  if((x1-x0+1)<w*0.1||(y1-y0+1)<h*0.4)return null;
  return {x0:x0/k,y0:y0/k,x1:(x1+1)/k,y1:(y1+1)/k,w:nw,h:nh};
}
function frameBody(img){
  // Her full-body photo framed head to feet, centred on her: the empty sides of a
  // wide photo are cut, never her head or her feet (a little room is kept around).
  var b=img._adalBox;if(b===undefined)b=img._adalBox=personBox(img);if(!b)return;
  var r=img.getBoundingClientRect();if(!r.width||!r.height)return;
  var A=r.width/r.height,nw=b.w,nh=b.h,bh=b.y1-b.y0;
  // a picture sized by itself (width/height auto): framed to the box it sits in
  var q=img.parentElement&&img.parentElement.getBoundingClientRect();
  if(q&&q.width&&q.height&&Math.abs(A-nw/nh)<nw/nh*0.02)A=q.width/q.height;
  // Sideways she is cut to her box; above her head only a little empty wall goes,
  // and nothing below: shoes on a dark floor are easy to miss, so her feet stay.
  var x0=Math.max(0,b.x0-bh*0.06),x1=Math.min(nw,b.x1+bh*0.06),y0=b.y0-bh*0.07,y1=nh;
  y0=y0<nh*0.04?0:Math.min(y0,nh*0.12);
  var cw=x1-x0,ch=y1-y0,cx=(x0+x1)/2,cy=(y0+y1)/2;
  if(cw/ch<A){cw=Math.min(nw,ch*A);x0=Math.max(0,Math.min(nw-cw,cx-cw/2));x1=x0+cw}
  else{ch=Math.min(nh,cw/A);y0=Math.max(0,Math.min(nh-ch,cy-ch/2));y1=y0+ch}
  var pc=function(v,t){return Math.max(0,v/t*100).toFixed(2)+'%'};
  var st=img.style;
  if(window.CSS&&CSS.supports&&CSS.supports('object-view-box','inset(1%)')){
    st.setProperty('object-view-box','inset('+pc(y0,nh)+' '+pc(nw-x1,nw)+' '+pc(nh-y1,nh)+' '+pc(x0,nw)+')','important');
  }else if(!img._adalCut){
    var c=document.createElement('canvas');c.width=Math.round(x1-x0);c.height=Math.round(y1-y0);
    try{c.getContext('2d').drawImage(img,x0,y0,x1-x0,y1-y0,0,0,c.width,c.height);img._adalCut=1;img._adalBox=null;img.removeAttribute('data-adal-box');img.src=c.toDataURL('image/jpeg',0.88)}catch(e){}
  }
  st.setProperty('object-fit','contain','important');st.setProperty('object-position','center','important');
}
function frameBodies(){var l=document.querySelectorAll('img[data-adal-body]');for(var i=0;i<l.length;i++)frameBody(l[i])}
function fitDesign(){
  // A page made from a design (.cv): its full-body photo frame takes exactly the
  // room the header and the other blocks leave, so the design fills the whole
  // A4 page at full width — never shrunk to fit (that left the right side empty).
  var p=document.querySelector('.adal-page'),b=p&&p.querySelector('.adal-body'),fb=b&&b.querySelector('.cv .fb');
  if(!fb||p.dataset.fitted)return false;p.dataset.fitted='1';
  var limit=Math.floor(297*96/25.4),min=Math.round(45*96/25.4);
  for(var i=0;i<3;i++){
    var top=p.getBoundingClientRect().top,last=b.lastElementChild,bottom=0;
    for(var c=b.firstElementChild;c;c=c.nextElementSibling)bottom=Math.max(bottom,c.getBoundingClientRect().bottom-top);
    var d=limit-2-Math.ceil(bottom);if(Math.abs(d)<2)break;
    var h=Math.max(min,fb.getBoundingClientRect().height+d);fb.style.setProperty('height',h+'px','important');
    if(h===min)break;
  }
  var z=100;while(z>70&&b.scrollHeight>limit+1){z-=3;b.style.zoom=z/100}
  p.style.height='297mm';p.style.maxHeight='297mm';p.style.overflow='hidden';
  return true;
}
function fit(){
  frameBodies();
  if(fitDesign()){frameBodies();return}
  var p=document.querySelector('.cv-page');if(!p||p.dataset.fitted){frameBodies();return}p.dataset.fitted='1';
  var limit=Math.floor(297*96/25.4)+1,tall=function(){return p.scrollHeight>limit};
  var st=document.createElement('style');document.head.appendChild(st);
  for(var n=6;n>=2&&tall();n--)st.textContent='.cv-page td{padding-top:'+n+'px!important;padding-bottom:'+n+'px!important}';
  var b=p.querySelector('.cv-body')||p;
  for(var z=98;z>=60&&tall();z-=2)b.style.zoom=z/100;
  p.style.height='297mm';p.style.overflow='hidden';
  frameBodies();
}
window.adalFit=fit;
if(document.readyState==='complete')fit();else addEventListener('load',fit);
})()</script>`

export function mergeTemplate(html, css, data) {
  let out = splitLanguageCells(html || '')

  // Base CSS — force A4 tall page
  const baseCss = `html,body{margin:0;padding:0;min-height:297mm;box-sizing:border-box;} @page{size:A4;margin:0;} body{display:flex;flex-direction:column;min-height:297mm;} .adal-page{flex:1;display:flex;flex-direction:column;} .adal-body{flex:1;}`
  const combinedCss = baseCss + '\n' + (css || '') + PAGE_CSS + (/max-height:\s*220px/.test(css || '') ? WIDE_PHOTOS_CSS : '')

  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `<style>${combinedCss}</style></head>`)
  else out = `<style>${combinedCss}</style>` + out

  // Wrap body content in .adal-page so header + footer can stick to top/bottom
  const bodyMatch = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) {
    const inner = bodyMatch[1]
    const wrapped = `<body><div class="adal-page"><div class="adal-body">${inner}</div></div></body>`
    out = out.replace(/<body[^>]*>[\s\S]*?<\/body>/i, wrapped)
  }

  // No header/footer image on this template: drop the <img> (an empty src
  // prints a broken-image box with its alt text).
  for (const k of ['HEADER_IMAGE', 'FOOTER_IMAGE']) {
    if (!data[k]) out = out.replace(new RegExp(`<img\\b[^>]*\\{\\{${k}\\}\\}[^>]*>`, 'gi'), '')
  }

  // Her full-body photo is framed on her by the page itself (frameBody in FIT_SCRIPT).
  const box = /^[0-9.,]+$|^none$/.test(data.FULL_BODY_BOX || '') ? ` data-adal-box="${data.FULL_BODY_BOX}"` : ''
  out = out.replace(/<img\b(?=[^>]*\{\{FULL_BODY_PHOTO_URL\}\})/gi, `<img data-adal-body="1"${box}`)

  // Replace tokens
  out = out.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    const v = data[k]
    return v == null ? '' : String(v)
  })

  // If template didn't have a HEADER_IMAGE token, prepend one
  if (data.HEADER_IMAGE && !/\{\{HEADER_IMAGE\}\}/.test(html)) {
    const headerBlock = `<div style="width:100%;padding:0;margin:0;"><img src="${data.HEADER_IMAGE}" style="display:block;width:100%;height:auto;max-height:40mm;object-fit:contain;" /></div>`
    out = out.replace(/<div class="adal-body">/i, `<div class="adal-body">${headerBlock}`)
  }
  // If template didn't have a FOOTER_IMAGE token, append one
  if (data.FOOTER_IMAGE && !/\{\{FOOTER_IMAGE\}\}/.test(html)) {
    const footerBlock = `<div style="width:100%;padding:0;margin:0;"><img src="${data.FOOTER_IMAGE}" style="display:block;width:100%;height:auto;max-height:25mm;object-fit:contain;" /></div>`
    out = out.replace(/<\/div><\/body>/i, `${footerBlock}</div></body>`)
  }

  // AUTO_PASSPORT_PAGE — configurable header/footer/H1 per template
  if (data.PASSPORT_URL && data.PASSPORT_PAGE_INCLUDE) {
    const includeHeader = data.PASSPORT_PAGE_INCLUDE_HEADER !== false && !!data.HEADER_IMAGE
    const includeFooter = data.PASSPORT_PAGE_INCLUDE_FOOTER !== false && !!data.FOOTER_IMAGE
    const h1 = data.PASSPORT_PAGE_H1 || ''
    const h1Color = data.PASSPORT_PAGE_H1_COLOR || '#000000'

    const headerHtml = includeHeader
      ? '<div style="width:100%;"><img src="' + data.HEADER_IMAGE + '" style="display:block;width:100%;height:auto;" /></div>'
      : ''
    const footerHtml = includeFooter
      ? '<div style="width:100%;"><img src="' + data.FOOTER_IMAGE + '" style="display:block;width:100%;height:auto;" /></div>'
      : ''
    const h1Html = h1
      ? '<h1 style="font-family:Arial,sans-serif;font-size:22pt;font-weight:bold;color:' + h1Color + ';text-align:center;margin:6mm 0 4mm 0;letter-spacing:1px;">' + h1 + '</h1>'
      : ''

    const passportPage =
      '<div style="page-break-before:always;flex:none;margin:0 auto;width:210mm;height:297mm;padding:8px 16px;box-sizing:border-box;display:flex;flex-direction:column;background:#fff;">' +
        headerHtml + h1Html +
        '<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:2mm 0;min-height:0;"><img src="' + data.PASSPORT_URL + '" style="max-width:100%;max-height:100%;object-fit:contain;" /></div>' +
        footerHtml +
      '</div>'

    // Bulletproof insertion — try </body>, then </html>, then just append
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, passportPage + '</body>')
    } else if (/<\/html>/i.test(out)) {
      out = out.replace(/<\/html>/i, passportPage + '</html>')
    } else {
      // No wrapper at all — build one and wrap everything
      out = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:0;} html,body{margin:0;padding:0;}</style></head><body>' + out + passportPage + '</body></html>'
    }
  }

  return /<\/body>/i.test(out) ? out.replace(/<\/body>/i, FIT_SCRIPT + '</body>') : out + FIT_SCRIPT
}

// ---- backend routes/cv.js withEdits, word for word
export function withEdits(html, edits) {
  const list = (Array.isArray(edits) ? edits : []).filter(e => e && typeof e.from === 'string' && typeof e.to === 'string' && e.from.trim() && e.from !== e.to)
    .slice(0, 300).map(e => ({ from: e.from.trim().slice(0, 4000), to: e.to.slice(0, 4000) }))
  if (!list.length) return html
  const json = JSON.stringify(list).replace(/</g, '\u003c')
  const js = `<script>(function(){var E=${json};var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),n,a=[];while(n=w.nextNode())a.push(n);a.forEach(function(t){var v=t.nodeValue,k=v.trim();if(!k)return;for(var i=0;i<E.length;i++)if(E[i].from===k){t.nodeValue=v.replace(k,E[i].to);break}})})()</script>`
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at >= 0 ? html.slice(0, at) + js + html.slice(at) : html + js
}

// ---- her pictures, made small here as the PC does (sharp there, a canvas here)
async function bitmapOf(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }) } catch {}
  const url = URL.createObjectURL(blob)
  try { const img = new Image(); img.src = url; await img.decode(); return img } finally { setTimeout(() => URL.revokeObjectURL(url), 2000) }
}
const dataUrlOf = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(blob) })

// The white around a full-body photo cut off (the PC: sharp trim, threshold 25).
function whiteBox(bmp) {
  const k = Math.min(1, 600 / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k))
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0, w, h)
  const d = x.getImageData(0, 0, w, h).data
  let top = h, left = w, right = -1, bottom = -1
  for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) {
    const o = (y * w + i) * 4
    if (255 - d[o] > 25 || 255 - d[o + 1] > 25 || 255 - d[o + 2] > 25) { if (y < top) top = y; if (y > bottom) bottom = y; if (i < left) left = i; if (i > right) right = i }
  }
  if (right < 0) return null
  return { sx: left / k, sy: top / k, sw: (right - left + 1) / k, sh: (bottom - top + 1) / k }
}

/** A picture as a data: link at most maxPx on its long side (a PDF: none — the phone cannot draw one). */
export async function imageUri(blob, maxPx, { trim = false } = {}) {
  if (!blob) return ''
  const type = blob.type || ''
  if (!type.startsWith('image/')) return /pdf/i.test(type) ? '' : dataUrlOf(blob)
  try {
    const bmp = await bitmapOf(blob)
    let box = { sx: 0, sy: 0, sw: bmp.width, sh: bmp.height }
    if (trim) box = whiteBox(bmp) || box
    const k = Math.min(1, maxPx / Math.max(box.sw, box.sh))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(box.sw * k)); c.height = Math.max(1, Math.round(box.sh * k))
    const x = c.getContext('2d', { willReadFrequently: true })
    x.drawImage(bmp, box.sx, box.sy, box.sw, box.sh, 0, 0, c.width, c.height)
    // Transparent banners stay PNG; everything else a JPEG (quality 85).
    let alpha = false
    if (/png|webp|gif/.test(type)) { const d = x.getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { alpha = true; break } }
    return alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85)
  } catch { return dataUrlOf(blob) }
}

/**
 * Her CV page (HTML) made here. src gives what the phone keeps:
 *   { profile(id), fields(id), template(id), banners(id), broker(id), blob(fileId) }
 */
export async function cvHtml(src, profileId, templateId, overrides = {}) {
  const [profile, fields, template] = await Promise.all([src.profile(profileId), src.fields(profileId), src.template(templateId)])
  if (!profile) throw new Error('Profile not found on this phone')
  if (!template?.html_content) throw new Error('This CV template is not on this phone yet: open Adal Keep once with the PC on')
  // Her newest file in that field, a picture before a PDF (as the PC picks; files added here first).
  const pick = (name) => {
    const files = (fields || []).filter(f => f.name === name).flatMap(f => f.files || [])
      .sort((a, b) => (Number(b.id) < 0 ? 1e15 - Number(b.id) : Number(b.id)) - (Number(a.id) < 0 ? 1e15 - Number(a.id) : Number(a.id)))
    return files.find(f => String(f.mimetype || '').startsWith('image/')) || files[0] || null
  }
  const one = async (file, px, opt) => { if (!file) return ''; try { return await imageUri(await src.blob(file.id), px, opt) } catch { return '' } }
  const [banners, broker] = await Promise.all([
    src.banners(templateId).catch(() => null),
    profile.broker_id ? src.broker(profile.broker_id).catch(() => null) : null,
  ])
  const [photo, fullBody, passport] = await Promise.all([one(pick('Photo'), 800), one(pick('Full Body Photo'), 1400, { trim: true }), one(pick('Passport'), 1600)])
  const data = await cvData(profile, template, overrides, { photo, fullBody, passport, header: banners?.header || '', footer: banners?.footer || '' }, broker?.contact1 || '')
  return withEdits(mergeTemplate(template.html_content, template.css_content, data), overrides.__edits)
}
