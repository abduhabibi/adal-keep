/*
 * Adal Keep — fills a portal's forms with the profile's details, on the phone
 * (AdalBrowserActivity runs it only on the portal's own site).
 *   window.__adalFill(profile, plans) → number of boxes filled
 *
 * 1. The portal's plan first (made on the PC, services/phoneFillPlan.js): the
 *    same boxes the PC's robots fill, found the same way (placeholder, label,
 *    a list's first choice, the nth date box of a window) with the same values.
 * 2. Then any other box whose OWN label names it clearly (its <label>,
 *    aria-label, placeholder or name, or the words in a row that holds only
 *    that box). A name that fits two boxes is left alone, and on a portal with
 *    a plan, dates come only from the plan — so a date never lands in the
 *    wrong box.
 * Only empty boxes the person has not typed in; filled ones are outlined
 * green; new steps of a form fill as they appear. Never a button, password,
 * code or captcha.
 */
(function () {
  if (window.__adalFillReady) return
  window.__adalFillReady = true

  // [key, label pattern] — the more particular ones first.
  var RULES = [
    ['emergency_labor_id', /emergency.*(labou?r|lmis)\s*id/i],
    ['emergency_phone', /(emergency|contact\s*person|relative).*(phone|mobile|tel)|رقم.*الطوارئ/i],
    ['emergency_name', /(emergency|contact\s*person|relative).*name|اسم.*الطوارئ/i],
    ['emergency_relationship', /relationship|kinship|صلة\s*القرابة/i],
    ['labor_id', /labou?r\s*id|lmis\s*id/i],
    ['passport_number', /passport\s*(no|num|#)|^passport$|رقم\s*الجواز|رقم\s*جواز/i],
    ['passport_issue_date', /(passport.*issu.*date|issu(e|ing)\s*date|date\s*of\s*issu|تاريخ\s*الإصدار)/i],
    ['passport_expiry_date', /(expir.*date|date\s*of\s*expir|valid\s*(until|till)|تاريخ\s*الانتهاء)/i],
    ['date_of_birth', /(birth\s*date|date\s*of\s*birth|\bdob\b|تاريخ\s*الميلاد)/i],
    ['place_of_birth', /(place\s*of\s*birth|birth\s*place|مكان\s*الميلاد)/i],
    ['mother_name', /mother|اسم\s*الأم/i],
    ['grandfather_name', /(grand\s*father|g\.\s*father|third\s*name|اسم\s*الجد)/i],
    ['father_name', /(father|second\s*name|اسم\s*الأب)/i],
    ['first_name', /(first\s*name|given\s*name|الاسم\s*الأول)/i],
    ['full_name', /(full\s*name|applicant\s*name|worker\s*name|candidate\s*name|الاسم\s*الكامل)/i],
    ['national_id', /(national\s*id|fayda|kebele\s*id)/i],
    ['phone_number', /(phone|mobile|telephone|الجوال|الهاتف)/i],
    ['religion', /religion|الديانة/i],
    ['marital_status', /marital|الحالة\s*الاجتماعية/i],
    ['gender', /(gender|\bsex\b|الجنس)/i],
    ['nationality', /^nationality$|الجنسية/i],
    ['education_level', /education|التعليم|المؤهل/i],
    ['children_count', /(number\s*of\s*child|children|عدد\s*الأطفال)/i],
    ['height', /^height|الطول/i],
    ['weight', /^weight|الوزن/i],
    ['region', /^region$|المنطقة/i],
    ['zone_subcity', /(^zone|sub\s*-?\s*city|woreda)/i],
    ['visa_number', /visa\s*(no|num)|رقم\s*التأشيرة/i],
    ['contract_number', /contract\s*(no|num)|رقم\s*العقد/i],
  ]
  var DATES = { passport_issue_date: 1, passport_expiry_date: 1, date_of_birth: 1 }
  var SKIP = /(password|captcha|otp|verification|code|search|user\s*name|login|رمز|كلمة\s*المرور)/i
  var CONTROLS = 'input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file]):not([type=image]),select,textarea'

  function visible(e) {
    var r = e.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    var s = getComputedStyle(e)
    return s.visibility !== 'hidden' && s.display !== 'none'
  }
  function clean(t) { return String(t || '').replace(/\s+/g, ' ').replace(/[*:：]/g, '').trim() }
  function usable(e) { return e && !e.disabled && !e.readOnly && visible(e) && !touched.has(e) }
  function mark(e) { filled.add(e); e.style.outline = '2px solid #10b981'; e.style.outlineOffset = '1px' }

  var touched = new WeakSet(), filled = new WeakSet(), planned = new WeakSet()
  document.addEventListener('input', function (ev) { if (ev.isTrusted && ev.target) touched.add(ev.target) }, true)
  document.addEventListener('change', function (ev) { if (ev.isTrusted && ev.target) touched.add(ev.target) }, true)

  // ---- putting a value in ---------------------------------------------------
  function put(e, value) {
    var proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    try { e.focus({ preventScroll: true }) } catch (x) {}
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value)
    e.dispatchEvent(new Event('input', { bubbles: true }))
    e.dispatchEvent(new Event('change', { bubbles: true }))
    e.dispatchEvent(new Event('keyup', { bubbles: true }))
    if (window.jQuery) try { window.jQuery(e).trigger('change') } catch (x) {}
    e.dispatchEvent(new Event('blur', { bubbles: true }))
    try { e.blur() } catch (x) {}
  }
  function iso(v) {
    var m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/)
    if (m) return m[0]
    m = String(v).match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/)
    return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : ''
  }
  // A date box: native date, the page's own date picker, else the format it shows.
  function putDate(e, value) {
    if (e.type === 'date') { var i = iso(value); if (!i) return false; put(e, i); return e.value === i }
    var m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) { put(e, value); return !!e.value }                     // already in the portal's words ("March 5, 2024")
    var y = +m[1], mo = +m[2], d = +m[3], $ = window.jQuery, date = new Date(y, mo - 1, d, 12)
    try { if ($ && $(e).data('datepicker')) $(e).datepicker('setDate', date) } catch (x) {}
    try { if ($ && $(e).data('DateTimePicker')) $(e).data('DateTimePicker').date(date) } catch (x) {}
    try { if ($ && $(e).hasClass('hasDatepicker')) $(e).datepicker('setDate', date) } catch (x) {}
    try { if ($ && $(e).hasClass('is-calendarsPicker') && $.calendars) $(e).calendarsPicker('setDate', $.calendars.instance('gregorian').newDate(y, mo, d)) } catch (x) {}
    if (!e.value) {
      var pad = function (n) { return ('0' + n).slice(-2) }
      var fmt = String(e.getAttribute('data-date-format') || e.placeholder || '').toLowerCase()
      put(e, /^y/.test(fmt) ? y + '-' + pad(mo) + '-' + pad(d) : /^mm/.test(fmt) ? pad(mo) + '/' + pad(d) + '/' + y : pad(d) + '/' + pad(mo) + '/' + y)
    }
    try { if ($) $('.datepicker, .ui-datepicker, .bootstrap-datetimepicker-widget').hide() } catch (x) {}
    return !!e.value
  }
  var PLACEHOLDER = /^\s*-*\s*(select|choose|اختر|--)/i
  function pickOption(sel, src, plain) {
    var opts = [].slice.call(sel.options).filter(function (o) { return !o.disabled && (o.text || '').trim() && !PLACEHOLDER.test(o.text) })
    var o = null
    if (src) { var re = new RegExp(src, 'i'); o = opts.filter(function (x) { return re.test(x.text.trim()) })[0] }
    else {
      var want = String(WORDS[String(plain).toUpperCase()] || plain).toLowerCase().trim()
      o = opts.filter(function (x) { return x.text.toLowerCase().trim() === want || x.value.toLowerCase() === want })[0] ||
          opts.filter(function (x) { return x.text.toLowerCase().trim().indexOf(want) === 0 })[0]
    }
    if (!o || sel.value === o.value) return false
    o.selected = true
    put(sel, o.value)
    if (window.jQuery) try { window.jQuery(sel).val(o.value).trigger('change') } catch (x) {}
    return sel.value === o.value
  }
  var WORDS = { F: 'female', M: 'male', FEMALE: 'female', MALE: 'male' }

  // ---- the plan ---------------------------------------------------------------
  function scopeOf(plan) {
    var sc = plan.scope
    if (!sc) return document
    if (sc.css) return document.querySelector(sc.css)
    if (sc.modal) {
      // the smallest window whose top shows the title and that holds boxes
      var best = null, area = Infinity, all = document.querySelectorAll('div,section,form,[role=dialog]')
      for (var i = 0; i < all.length; i++) {
        var el = all[i], r = el.getBoundingClientRect()
        if (r.width < 250 || r.height < 150) continue
        if ((el.textContent || '').slice(0, 400).indexOf(sc.modal) < 0) continue
        if (!el.querySelector('input,select,textarea')) continue
        if (r.width * r.height < area) { area = r.width * r.height; best = el }
      }
      return best
    }
    return document
  }
  function byLabel(root, src, kinds) {
    var re = new RegExp('^\\s*\\*?\\s*(?:' + src + ')\\s*\\*?\\s*:?\\s*\\*?\\s*$', 'i')
    var own = function (e) { return [].slice.call(e.childNodes).filter(function (n) { return n.nodeType === 3 }).map(function (n) { return n.textContent }).join(' ').replace(/\s+/g, ' ') }
    var labs = [].slice.call(root.querySelectorAll('label,span,div,td,th,p,strong,legend,h6,h5'))
      .filter(function (e) { return re.test(own(e)) || (e.children.length <= 2 && re.test((e.innerText || '').replace(/\s+/g, ' '))) })
    for (var i = 0; i < labs.length; i++) {
      var lab = labs[i], el = lab.htmlFor ? document.getElementById(lab.htmlFor) : null
      if (el && !el.matches(kinds)) el = el.querySelector ? el.querySelector(kinds) : null
      for (var box = lab.parentElement, up = 0; !el && box && up < 4; box = box.parentElement, up++) {
        el = [].slice.call(box.querySelectorAll(kinds)).filter(function (x) { return visible(x) && (lab.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) })[0] || null
      }
      if (el && visible(el)) return el
    }
    return null
  }
  function locate(root, at, kinds) {
    var list = function () { return [].slice.call(root.querySelectorAll(kinds)).filter(visible) }
    if (at.ph) { var w = at.ph.toLowerCase(); var e = list().filter(function (x) { return (x.placeholder || '').trim().toLowerCase() === w })[0]; if (e) return e }
    if (at.phHas) { var e2 = list().filter(function (x) { var p = (x.placeholder || '').toLowerCase(); return at.phHas.some(function (h) { return p.indexOf(h.toLowerCase()) >= 0 }) })[0]; if (e2) return e2 }
    if (at.first) { var f = at.first.toLowerCase(); var e3 = [].slice.call(root.querySelectorAll('select')).filter(function (s) { return ((s.options[0] && s.options[0].text) || '').trim().toLowerCase() === f })[0]; if (e3) return e3 }
    if (at.sel != null && at.nth != null) { var e4 = [].slice.call(root.querySelectorAll(at.sel)).filter(visible)[at.nth]; if (e4) return e4 }
    if (at.label) return byLabel(root, at.label, kinds)
    return null
  }
  function radio(root, src, answer) {
    var re = new RegExp(src, 'i'), want = new RegExp(answer, 'i')
    var q = [].slice.call(root.querySelectorAll('label,span,div,td,p,legend'))
      .filter(function (e) { var t = e.innerText || ''; return re.test(t) && t.length < 220 })
      .sort(function (a, b) { return (a.innerText || '').length - (b.innerText || '').length })[0]
    if (!q) return 0
    var text = function (r) { return ((r.labels && r.labels[0] && r.labels[0].innerText) || (r.nextSibling && r.nextSibling.textContent) || (r.parentElement && r.parentElement.innerText) || r.value || '').trim() }
    for (var box = q, i = 0; box && i < 5; box = box.parentElement, i++) {
      var radios = [].slice.call(box.querySelectorAll('input[type=radio]')).filter(function (r) { return q.contains(r) || (q.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) })
      if (!radios.length) continue
      if (radios.some(function (r) { return r.checked && touched.has(r) })) return 0       // the person chose
      var r = radios.filter(function (r) { return want.test(text(r)) || want.test(r.value) })[0]
      if (!r) return 0
      if (r.checked) return 0
      r.click()
      if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })) }
      return r.checked ? 1 : 0
    }
    return 0
  }
  function runPlan(plan) {
    var root = scopeOf(plan)
    if (!root) return 0
    var n = 0
    plan.steps.forEach(function (s) {
      try {
        if (s.k === 'radio') { n += radio(root, s.at.label, s.m); return }
        var kinds = s.k === 'select' ? 'select' : 'input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=file]):not([type=password]),textarea'
        var e = locate(root, s.at, kinds)
        if (!e) return
        planned.add(e)
        if (!usable(e)) return
        if (s.k === 'select') {
          if (!filled.has(e) && e.selectedIndex > 0 && !PLACEHOLDER.test(e.options[e.selectedIndex].text)) return   // already chosen
          if (pickOption(e, s.m, s.v)) { mark(e); n++ }
          return
        }
        if (e.value && !filled.has(e)) return                       // something is already there
        if (filled.has(e) && e.value) return
        var ok = s.k === 'date' ? putDate(e, s.v) : (put(e, s.v), !!e.value)
        if (ok) { mark(e); n++ }
      } catch (x) {}
    })
    return n
  }

  // ---- the guesser (boxes the plan does not cover) ---------------------------
  function labelParts(e) {
    var parts = []
    if (e.labels) for (var i = 0; i < e.labels.length; i++) parts.push(e.labels[i].innerText)
    var by = e.getAttribute('aria-labelledby')
    if (by) by.split(/\s+/).forEach(function (id) { var l = document.getElementById(id); if (l) parts.push(l.innerText) })
    parts.push(e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('formcontrolname'), e.name, e.id)
    // the words of the row — only a row that holds this one box
    for (var box = e.parentElement, up = 0; up < 3 && box; up++, box = box.parentElement) {
      if (box.querySelectorAll(CONTROLS).length > 1) break
      var t = clean(box.innerText)
      if (t && t.length < 60) { parts.push(t); break }
    }
    return parts.filter(Boolean).map(function (p) { return clean(String(p).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')) }).filter(Boolean)
  }
  function keyOf(e) {
    var parts = labelParts(e)
    if (!parts.length || parts.some(function (p) { return SKIP.test(p) })) return null
    for (var i = 0; i < RULES.length; i++)
      for (var j = 0; j < parts.length; j++) if (RULES[i][1].test(parts[j])) return RULES[i][0]
    return null
  }
  function guess(p, hasPlan) {
    var boxes = [].slice.call(document.querySelectorAll(CONTROLS)).filter(function (e) { return !planned.has(e) && usable(e) })
    var found = boxes.map(function (e) { return [e, keyOf(e)] }).filter(function (x) { return x[1] && p[x[1]] != null && String(p[x[1]]).trim() !== '' })
    var count = {}
    found.forEach(function (x) { count[x[1]] = (count[x[1]] || 0) + 1 })
    var n = 0
    found.forEach(function (x) {
      var e = x[0], key = x[1], value = String(p[key]).trim()
      if (count[key] > 1) return                                    // two boxes fit: not sure which
      if (DATES[key] && (hasPlan || e.type !== 'date' && !/date|birth|issu|expir/i.test((e.placeholder || '') + ' ' + (e.name || '') + ' ' + (e.id || '') + ' ' + (e.getAttribute('aria-label') || '')))) return
      try {
        if (e.tagName === 'SELECT') { if (pickOption(e, '', value)) { mark(e); n++ } return }
        if (e.value) return
        var ok = DATES[key] ? putDate(e, value) : (put(e, value), !!e.value)
        if (ok) { mark(e); n++ }
      } catch (z) {}
    })
    return n
  }

  window.__adalFill = function (p, plans) {
    if (p) window.__adalProfile = p
    if (plans) window.__adalPlans = plans
    p = window.__adalProfile || {}
    var host = location.hostname
    var mine = (window.__adalPlans || []).filter(function (pl) { return host === pl.site || host.slice(-pl.site.length - 1) === '.' + pl.site })
    var n = 0
    mine.forEach(function (pl) { n += runPlan(pl) })
    return n + guess(p, mine.length > 0)
  }

  // New steps of the form: filled as they appear (a moment after the page settles).
  var timer = null
  new MutationObserver(function () {
    if (!window.__adalAuto) return
    clearTimeout(timer)
    timer = setTimeout(function () {
      var n = window.__adalFill()
      if (n && window.AdalApp) window.AdalApp.filled(n)
    }, 700)
  }).observe(document.documentElement, { childList: true, subtree: true })
})()
