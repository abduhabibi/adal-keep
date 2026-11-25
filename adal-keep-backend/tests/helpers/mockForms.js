/** Mock forms: Musaned's Add Candidate (its controls as they are: plain Angular boxes, PrimeNG search lists, chips, a
 *  number spinner, an ng-bootstrap calendar) and Enjaz's visa form (jQuery, lists that load the next one, a Select2
 *  that searches on keys). window.model = what the form itself took. */
export const MUSANED_JOBS = ['House Maid', 'House Manager', 'Driver', 'Nurse']
const SKILLS = ['Babysitting', 'Hard worker', 'Nanny', 'Washing & ironing clothes', 'Dusting & cleaning', 'Washing kitchen dishes', 'Cooking']
const text = (label, name, type = 'text', cls = '') => `<div><label for="${name}">${label} <span>*</span></label><input id="${name}" formcontrolname="${name}" type="${type}" class="form-control ng-untouched ng-pristine ng-invalid ${cls}"></div>`
const auto = (label, name, list, multiple = false) => `<div><label for="${name}">${label}</label><p-autocomplete id="${name}" formcontrolname="${name}" class="p-autocomplete ng-pristine" data-list='${JSON.stringify(list).replace(/'/g, '&#39;')}' ${multiple ? 'data-multiple' : ''}>${multiple ? '<ul class="p-autocomplete-multiple-container p-autocomplete-input-multiple"></ul>' : ''}<input class="p-autocomplete-input p-inputtext" role="combobox" aria-autocomplete="list" autocomplete="off"></p-autocomplete></div>`
export const MUSANED_FORM = `<!doctype html><title>Add Candidate</title><style>.ov{position:absolute;background:#fff;border:1px solid #999;z-index:9}.ov div{padding:4px}.p-focus{background:#def}</style>
<h1>Add Candidate</h1>
<div><label>Marital Status</label><div><input type=radio name=m id=m1><label for=m1>Single</label><input type=radio name=m id=m2><label for=m2>Married</label></div></div>
<div><label>Religion</label><div><input type=radio name=r id=r1><label for=r1>Muslim</label><input type=radio name=r id=r2><label for=r2>Non Muslim</label></div></div>
${auto('Job', 'career', MUSANED_JOBS)}${auto('Education level', 'qualifications', ['Preparatory School', 'Primary School', 'Diploma'], true)}${auto('Languages', 'language', ['None', 'Arabic', 'English'])}${auto('Experience', 'hasExperience', ['No experience', 'Have experience'])}
${auto('Skills', 'skills', SKILLS, true)}
${text('Mobile Number', 'mobileNumber')}${text('E-Mail', 'email', 'email')}
<div><label for="children">Number Of Children</label><p-inputnumber formcontrolname="children"><input id="children" role="spinbutton" inputmode="decimal" class="form-control p-inputnumber-input p-inputtext" value="0"></p-inputnumber></div>
${text('Passport Issue Place', 'passportIssuePlace')}
<div><label for="issue">Passport Issue Date</label><app-calendar formcontrolname="issue"><input ngbdatepicker readonly><button type=button class=cal>cal</button></app-calendar></div>
${text('City', 'city')}${text('Address', 'address')}${text('Relative name', 'relativeContactName')}${text('Relative kinship', 'relativeContactKinship')}${text('Relative phone', 'relativeContactPhone', 'text', 'picky')}${text('Relative address', 'relativeContactAddress')}
<button id=save onclick="saved++">Save</button>
<script>
saved = 0; window.model = {}
for (const r of document.querySelectorAll('input[type=radio]')) r.onchange = () => { model[r.name] = r.nextElementSibling.textContent }
// Angular's plain boxes: the form hears 'input'. "picky": only a person's (trusted); its own value comes back.
for (const i of document.querySelectorAll('input.form-control:not([role])')) i.addEventListener('input', (e) => {
  if (i.classList.contains('picky') && !e.isTrusted) { setTimeout(() => { i.value = model[i.id] || '' }, 30); return }
  model[i.id] = i.value; i.classList.remove('ng-pristine'); i.classList.add('ng-dirty')
})
// PrimeNG's number box: arrows step it, Enter takes what is written.
{ const n = document.getElementById('children'); let v = 0
  n.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { v = Math.max(0, (Number(n.value) || 0) - 1); n.value = v; model.children = v } if (e.key === 'ArrowUp') { v = (Number(n.value) || 0) + 1; n.value = v; model.children = v } if (e.key === 'Enter') { v = Number(n.value) || 0; n.value = v; model.children = v } }) }
// PrimeNG's search list: searches 300 ms after the last change, its answer 60 ms later; ↓ highlights, Enter / Tab takes.
for (const host of document.querySelectorAll('p-autocomplete')) {
  const inp = host.querySelector('input'), list = JSON.parse(host.dataset.list), multi = 'multiple' in host.dataset, name = host.id, ul = host.querySelector('ul')
  const ov = document.createElement('div'); ov.className = 'ov p-autocomplete-panel'; ov.style.display = 'none'; document.body.append(ov)
  let t = null, at = -1
  const chips = () => [...ul.querySelectorAll('.p-autocomplete-token .p-autocomplete-token-label')].map(x => x.textContent)
  const hide = () => { ov.style.display = 'none'; at = -1; inp.removeAttribute('aria-activedescendant') }
  const take = (v) => { clearTimeout(t); if (multi) { const li = document.createElement('li'); li.className = 'p-autocomplete-token'; li.innerHTML = '<span class=p-autocomplete-token-label></span>'; li.firstChild.textContent = v; ul.append(li); inp.value = ''; model[name] = chips() } else { inp.value = v; model[name] = v } hide() }
  inp.addEventListener('input', () => { clearTimeout(t); window.searches = (window.searches || 0) + 1; if (!multi) delete model[name]; t = setTimeout(() => setTimeout(() => {
    const q = inp.value.toLowerCase(); const hit = list.filter(x => x.toLowerCase().includes(q)); ov.replaceChildren(...hit.map(x => { const d = document.createElement('div'); d.className = 'p-autocomplete-option'; d.role = 'option'; d.textContent = x; d.onmousedown = (e) => { e.preventDefault(); take(x) }; return d }))
    const r = inp.getBoundingClientRect(); Object.assign(ov.style, { display: hit.length ? 'block' : 'none', left: r.left + scrollX + 'px', top: r.bottom + scrollY + 'px' }); at = -1 }, 60), 300) })
  inp.addEventListener('keydown', (e) => {
    const o = [...ov.children], open = ov.style.display !== 'none' && o.length
    if (e.key === 'ArrowDown' && open) { at = Math.min(o.length - 1, at + 1); o.forEach((x, i) => x.classList.toggle('p-focus', i === at)); inp.setAttribute('aria-activedescendant', 'x' + at) }
    if (e.key === 'Enter' && open && at >= 0) take(o[at].textContent)
    if (e.key === 'Tab' && open && multi) { e.preventDefault(); take(o[Math.max(0, at)].textContent) }
    if (e.key === 'Escape') hide()
    if (e.key === 'Backspace' && multi && !inp.value) { ul.lastElementChild?.remove(); model[name] = chips() }
  })
  inp.addEventListener('blur', () => { if (!multi && model[name] === undefined) inp.value = '' })
}
document.querySelector('.cal').onclick = () => { if (document.querySelector('ngb-datepicker')) return; const d = document.createElement('ngb-datepicker'); d.style.display = 'block'
  const draw = () => { d.innerHTML = '<select title="Select month">' + Array.from({ length: 12 }, (_, i) => '<option value=' + (i + 1) + '>' + (i + 1) + '</option>').join('') + '</select><select title="Select year">' + Array.from({ length: 20 }, (_, i) => '<option value=' + (2016 + i) + '>' + (2016 + i) + '</option>').join('') + '</select>' + Array.from({ length: 28 }, (_, i) => '<div class="ngb-dp-day" style="display:inline-block;width:20px">' + (i + 1) + '</div>').join('') }
  draw(); document.body.append(d)
  d.onclick = (e) => { const day = e.target.closest('.ngb-dp-day'); if (!day) return; const [m, y] = d.querySelectorAll('select'); model.issue = y.value + '-' + m.value + '-' + day.textContent; document.querySelector('app-calendar input').value = model.issue; setTimeout(() => d.remove(), 0) } }
</script>`

const opt = (xs) => '<option value="">-- Select --</option>' + xs.map((x, i) => `<option value="${i + 1}">${x}</option>`).join('')
const sel = (label, id, xs = []) => `<div><label for="${id}">${label}</label><select id="${id}">${opt(xs)}</select></div>`
const box = (label, id) => `<div><label for="${id}">${label}</label><input id="${id}" type="text"></div>`
const yesno = (q, n) => `<div><label>${q}</label><div><input type=radio name=${n} value=Yes id=${n}y><label for=${n}y>Yes</label><input type=radio name=${n} value=No id=${n}n><label for=${n}n>No</label></div></div>`
export const ENJAZ_FORM = `<!doctype html><title>Visa</title><div>${sel('Visa Type', 'vt', ['Work', 'Visit'])}${sel('Current Nationality', 'cn', ['Ethiopia', 'Kenya'])}${sel('Nearest Saudi Mission', 'ms')}${sel('Number of Entries', 'ne', ['Single'])}${sel('Visa Validity', 'vv', ['90'])}${sel('Duration Of Stay', 'ds', ['90'])}
${box('Document', 'DocumentNumber')}${sel('Occupation', 'JOB_OR_RELATION_Id')}${box('Last/Family Name', 'fam')}${box('First Name', 'fir')}${box('Second/Father Name', 'fat')}
${yesno('Do you have previous nationality', 'pn')}${box('Passport Number', 'pnum')}${sel('Passport Type', 'pt', ['Ordinary', 'Diplomatic'])}
<div><label for="ic">Issuing Country</label><select id="ic" class="select2-hidden"><option value="">-- Select --</option></select><span class="select2 select2-container"><span class="select2-selection" style="display:inline-block;width:120px;height:24px;border:1px solid">…</span></span></div>
${box('Date of Issue', 'di')}${box('Date of Expiry', 'de')}${box('Place of Birth', 'pb')}${box('Date of Birth', 'db')}${sel('Religion', 're', ['Muslim', 'Christian'])}${sel('Marital Status', 'ma', ['Single', 'Married'])}${sel('Gender', 'ge', ['Female', 'Male'])}
${box('Qualification', 'qu')}${box('Source of Degree', 'so')}${box('KSA Home Address', 'ks')}${box('Email Address', 'em')}${box('Sponsor Name', 'sn')}${box('Sponsor ID Number', 'si')}${box('Sponsor Address', 'sa')}${box('Phone Number', 'ph')}${sel('Transport Mode', 'tm', ['Air', 'Land'])}${box('Expected Entry Date To KSA', 'ee')}${box('Purpose', 'pu')}
${yesno('Have you ever traveled to other countries', 'tr')}<label><input type=checkbox id=c1> I hereby declare that</label><label><input type=checkbox id=c2> I agree to Privacy Policy</label>
<div><label for="cap">Captcha</label><input id="cap" name="captcha" type="text"></div><button id=save onclick="saved++">Save</button></div>
<script>
saved = 0; window.model = {}; window.jQuery = (el) => ({ val(v) { if (v === undefined) return el.value; el.value = v; return this }, trigger(t) { el.dispatchEvent(new Event(t, { bubbles: true })); return this }, data: () => undefined, hasClass: (c) => el.classList?.contains(c), hide() {} }); jQuery.active = 0
const ask = (ms, fn) => { jQuery.active++; setTimeout(() => { jQuery.active--; fn() }, ms) }
for (const e of document.querySelectorAll('input[type=text]')) e.addEventListener('change', () => { if (!e.dataset.mask) model[e.id] = e.value })
for (const e of document.querySelectorAll('select')) e.addEventListener('change', () => { model[e.id] = e.options[e.selectedIndex]?.text })
for (const e of document.querySelectorAll('input[type=radio],input[type=checkbox]')) e.addEventListener('change', () => { if (e.checked) model[e.name || e.id] = e.value })
const fill = (id, xs) => { const s = document.getElementById(id); s.replaceChildren(new Option('-- Select --', ''), ...xs.map((x, i) => new Option(x, i + 1))) }
vt.onchange = () => ask(350, () => fill('ms', [])); cn.onchange = () => ask(350, () => fill('ms', ['Addis Ababa']))
// Her visa number is looked up as it is typed (on keys).
DocumentNumber.addEventListener('keyup', () => { if (DocumentNumber.value.length === 10) ask(300, () => fill('JOB_OR_RELATION_Id', ['House work'])) })
// "picky": the sponsor's phone puts its own value back when a script sets it.
ph.addEventListener('input', (e) => { if (!e.isTrusted && !ph.dataset.done) { ph.dataset.done = 1; setTimeout(() => { ph.value = ''; delete model.ph }, 20) } })
// Select2: opens on a click, searches on keys.
{ const c = document.querySelector('.select2-container'); c.querySelector('.select2-selection').onclick = () => { if (document.querySelector('.select2-container--open')) return
  const o = document.createElement('div'); o.className = 'select2-container--open'; o.innerHTML = '<input class="select2-search__field"><div class=res></div>'; document.body.append(o); const q = o.querySelector('input'); q.focus()
  q.addEventListener('keyup', () => setTimeout(() => { o.querySelector('.res').replaceChildren(...['Ethiopia', 'Eritrea'].filter(x => x.toLowerCase().includes(q.value.toLowerCase())).map(x => { const d = document.createElement('div'); d.className = 'select2-results__option'; d.textContent = x; d.onclick = () => { ic.replaceChildren(new Option(x, '1', true, true)); model.ic = x; o.remove() }; return d })) }, 100)) } }
</script>`
