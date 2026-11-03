/**
 * Print for the embassy: 3 pages a girl —
 *   1. her contract's first page (Musaned's contract PDF)
 *   2. the page that shows the visa is paid (from Enjaz; when it is kept)
 *   3. our page: the embassy application form with the visa number and the
 *      application number as barcodes at the top.
 * Drawn in a hidden frame and sent to the printer.
 */
import api from '../services/api'
import { barcodeSvg } from './barcode'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const day = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : esc(d) }
const cap = (s) => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())

function picturePage(src, what, name) {
  return src
    ? `<section class="page pic"><img src="${src}"></section>`
    : `<section class="page missing"><div><b>${esc(what)}</b><br>${esc(name)}<br><small>Not in Adal Keep yet — print it from ${what === 'Contract' ? 'Musaned' : 'Enjaz'} and put it here.</small></div></section>`
}

function formPage(g, agency, email) {
  const p = g.profile
  const row = (en, v, ar, en2 = '', v2 = '', ar2 = '') => `<tr><td class="l">${en}</td><td class="v">${esc(v)}</td><td class="r">${ar}</td>${en2 || ar2 ? `<td class="l">${en2}</td><td class="v">${esc(v2)}</td><td class="r">${ar2}</td>` : '<td colspan="3"></td>'}</tr>`
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/')
  return `<section class="page form">
  <div class="codes">
    <div>${barcodeSvg(p.visa_number, { width: 250, height: 46 })}<p><b>Visa Number:</b> ${esc(p.visa_number || '—')}</p><p><b>Sponsor Name:</b> ${esc(p.employer_name || '')}</p></div>
    <div class="right">${barcodeSvg(p.visa_application_number, { width: 250, height: 46 })}<p><b>${esc(p.visa_application_number || 'No application number yet')}</b></p></div>
  </div>
  <div class="head">
    <div class="photo">${g.photo ? `<img src="${g.photo}">` : ''}</div>
    <div class="emb">EMBASSY OF SAUDI ARABIA<br>CONSULAR SECTION<br><span dir="rtl">سفارة المملكة العربية السعودية<br>القسم القنصلي</span><br><b class="ag">${esc(agency)}</b><br><b>${esc(email)}</b></div>
  </div>
  <table>
    ${row('Full Name:', p.full_name, 'الاسم الكامل')}
    ${row("Mother's Name:", p.mother_name, 'اسم الأم')}
    ${row('Date of Birth:', day(p.date_of_birth), 'تاريخ الولادة', 'Place of Birth:', p.place_of_birth, 'مكان الولادة')}
    ${row('Previous Nationality:', cap(p.nationality || 'Ethiopia'), 'الجنسية السابقة', 'Present Nationality:', cap(p.nationality || 'Ethiopia'), 'الجنسية الحالية')}
    ${row('Sex:', /^m/i.test(p.gender || '') ? 'Male' : 'Female', 'الجنس', 'Marital Status:', String(p.marital_status || '').toLowerCase(), 'الحالة الاجتماعية')}
    ${row('Sec:', '', 'المذهب', 'Religion:', cap(p.religion), 'الديانة')}
    ${row('Place of Issue:', 'Addis Ababa', 'مصدره', 'Qualification:', '', 'المؤهل العلمي')}
    ${row('Profession:', cap(p.job_title || 'House Maid'), 'المهنة')}
    ${row('Home Address and Telephone No:', '', 'عنوان المنزل ورقم الهاتف')}
    ${row('Business Address and Telephone No:', '', 'عنوان العمل ورقم الهاتف')}
    <tr><td class="l">Purpose of Travel:</td><td colspan="4" class="v"><span class="chip on">Work</span><span class="chip">Transit</span><span class="chip">Visit</span><span class="chip">Umrah</span><span class="chip">Residence</span><span class="chip">Hajj</span><span class="chip">Diplomacy</span></td><td class="r">الغاية من السفر</td></tr>
    ${row('Place of Issue:', 'Addis Ababa', 'محل الإصدار', 'Date of Issue:', day(p.passport_issue_date), 'تاريخ الإصدار')}
    ${row('Passport No:', p.passport_number, 'رقم الجواز', "Date of Passport's Expiry:", day(p.passport_expiry_date), 'تاريخ انتهاء الجواز')}
    ${row('Duration of Stay in the kingdom:', '90 Days', 'مدة الإقامة بالمملكة', 'Date of Arrival:', '', 'تاريخ الوصول')}
    ${row('Date of Departure:', '', 'تاريخ المغادرة', 'Mode of payment:', '', 'طريقة الدفع')}
    ${row('Payment No:', '', 'رقم الدفع', 'Date:', today, 'التاريخ')}
    ${row('Relationship:', '', 'صلة', 'Destination:', p.work_city, 'المكان المقصود')}
    ${row('Dealer Name:', '', 'اسم التاجر')}
    ${row('Name and Address of company or individual in the kingdom:', [p.employer_name, p.employer_address].filter(Boolean).join(' — '), 'اسم وعنوان الشركة أو الفرد في المملكة')}
  </table>
  <p class="cert">The undersigned hereby certify that all the information I have provided are correct. I will abide by the laws of the Kingdom during the period of my resident in it.</p>
  <p class="sign"><b>Date:</b> ${today} &nbsp; &nbsp; <b>Signature</b> ____________ &nbsp; &nbsp; <b>Name:</b> ${esc(p.full_name)}</p>
</section>`
}

const CSS = `
@page { size: A4; margin: 8mm }
* { box-sizing: border-box }
body { margin: 0; font: 11px/1.35 Arial, sans-serif; color: #111 }
.page { page-break-after: always; break-after: page; height: 279mm; overflow: hidden }
.page:last-child { page-break-after: auto }
.pic { display: flex; align-items: flex-start; justify-content: center }
.pic img { max-width: 100%; max-height: 279mm; object-fit: contain }
.missing { display: flex; align-items: center; justify-content: center; text-align: center; border: 2px dashed #bbb; font-size: 16px; color: #555 }
.codes { display: flex; justify-content: space-between; border-bottom: 1px solid #ccc; padding-bottom: 6px }
.codes p { margin: 2px 0 } .codes .right { text-align: right }
.head { display: flex; justify-content: space-between; align-items: flex-start; margin: 8px 0 }
.photo { width: 30mm; height: 38mm; border: 1px solid #ccc } .photo img { width: 100%; height: 100%; object-fit: cover }
.emb { text-align: center; font-size: 12px } .emb .ag { font-size: 16px }
table { width: 100%; border-collapse: collapse }
td { border-bottom: 1px solid #ddd; padding: 3px 4px; vertical-align: top }
td.l { color: #333; width: 15% } td.v { font-weight: bold; width: 18% } td.r { text-align: right; direction: rtl; width: 13% }
.chip { display: inline-block; border: 1px solid #ccc; border-radius: 4px; padding: 0 5px; margin-right: 3px; font-weight: normal }
.chip.on { background: #eee; font-weight: bold }
.cert { margin-top: 10px } .sign { margin-top: 10px }
`

/** What each girl's embassy pages need, and what she lacks: [{ g, missing: [...] }]. */
export async function loadEmbassy(ids) {
  const { data } = await api.get('/embassy/print', { params: { ids: ids.join(',') } })
  const girls = (data.girls || []).map(g => ({
    g,
    missing: [
      !g.contract_page && 'Contract (PDF)',
      !g.payment_page && 'Visa payment page',
      !g.profile.visa_application_number && 'Application number',
      !g.profile.visa_number && 'Visa number',
      !g.photo && 'Photo',
    ].filter(Boolean),
  }))
  return { email: data.agency_email, girls }
}

/** Print these girls' pages (3 each); a page not in Adal Keep prints as a marked gap. */
export async function printEmbassy(loaded, girls, agency = '') {
  if (!girls.length) throw new Error('Nothing to print')
  const pages = girls.map(g =>
    picturePage(g.contract_page, 'Contract', g.profile.full_name) +
    picturePage(g.payment_page, 'Visa payment', g.profile.full_name) +
    formPage(g, agency, loaded.email)).join('')
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Embassy</title><style>${CSS}</style></head><body>${pages}</body></html>`)
  doc.close()
  await new Promise(r => setTimeout(r, 400))
  await Promise.all([...doc.images].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r })))
  frame.contentWindow.focus()
  frame.contentWindow.print()
  setTimeout(() => frame.remove(), 60000)
}
