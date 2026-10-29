/*
 * Adal Keep — fills a portal's forms with the profile's details, on the phone
 * (AdalBrowserActivity runs it only on the portal's own site).
 *   window.__adalFill(profile, { auto }) → number of boxes filled
 * It reads each box's label (its <label>, aria-label, placeholder, name, the
 * text beside it — English and Arabic), fills what it recognises, only when
 * the box is empty and the person has not typed in it, and marks it green.
 * New steps of a form are filled as they appear (auto). It never presses a
 * button, never touches passwords, codes or captchas.
 */
(function () {
  if (window.__adalFillReady) return
  window.__adalFillReady = true

  // [key, label pattern] — the more particular ones first.
  var RULES = [
    ['emergency_labor_id', /emergency.*(labou?r|lmis)\s*id/i],
    ['emergency_phone', /(emergency|contact\s*person|relative).*(phone|mobile|tel)|رقم.*الطوارئ/i],
    ['emergency_name', /(emergency|contact\s*person|relative).*name|اسم.*الطوارئ/i],
    ['emergency_relationship', /relationship|relation\b|صلة\s*القرابة/i],
    ['labor_id', /labou?r\s*id|lmis\s*id/i],
    ['passport_number', /passport\s*(no|num|#)|passport$|رقم\s*الجواز|رقم\s*جواز/i],
    ['passport_issue_date', /(passport.*issu|issu.*date|date\s*of\s*issu|تاريخ\s*الإصدار)/i],
    ['passport_expiry_date', /(expir|valid\s*(until|till|to)|تاريخ\s*الانتهاء)/i],
    ['date_of_birth', /(birth\s*date|date\s*of\s*birth|\bdob\b|تاريخ\s*الميلاد)/i],
    ['place_of_birth', /(place\s*of\s*birth|birth\s*place|مكان\s*الميلاد)/i],
    ['mother_name', /mother|اسم\s*الأم/i],
    ['grandfather_name', /(grand\s*father|last\s*name|surname|family\s*name|third\s*name|اسم\s*الجد|العائلة)/i],
    ['father_name', /(father|middle\s*name|second\s*name|اسم\s*الأب)/i],
    ['first_name', /(first\s*name|given\s*name|الاسم\s*الأول)/i],
    ['full_name', /(full\s*name|applicant\s*name|worker\s*name|employee\s*name|candidate\s*name|^name$|الاسم\s*الكامل|^الاسم$)/i],
    ['national_id', /(national\s*id|fayda|kebele\s*id|id\s*(no|number))/i],
    ['phone_number', /(phone|mobile|tel\b|telephone|الجوال|الهاتف)/i],
    ['religion', /religion|الديانة/i],
    ['marital_status', /marital|الحالة\s*الاجتماعية/i],
    ['gender', /(gender|\bsex\b|الجنس)/i],
    ['nationality', /nationality|الجنسية/i],
    ['education_level', /education|التعليم|المؤهل/i],
    ['children_count', /(children|kids|number\s*of\s*child|عدد\s*الأطفال)/i],
    ['height', /height|الطول/i],
    ['weight', /weight|الوزن/i],
    ['region', /\bregion\b|المنطقة/i],
    ['zone_subcity', /(zone|sub\s*-?\s*city|woreda)/i],
    ['visa_number', /visa\s*(no|num)|رقم\s*التأشيرة/i],
    ['contract_number', /contract\s*(no|num)|رقم\s*العقد/i],
  ]
  var SKIP = /(password|captcha|otp|verification|code|search|email|user\s*name|login|رمز|كلمة\s*المرور)/i

  function visible(e) {
    var r = e.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    var s = getComputedStyle(e)
    return s.visibility !== 'hidden' && s.display !== 'none'
  }
  function clean(t) { return String(t || '').replace(/\s+/g, ' ').replace(/[*:：]/g, '').trim() }
  function labelOf(e) {
    var parts = []
    if (e.labels) for (var i = 0; i < e.labels.length; i++) parts.push(e.labels[i].innerText)
    var by = e.getAttribute('aria-labelledby')
    if (by) by.split(/\s+/).forEach(function (id) { var l = document.getElementById(id); if (l) parts.push(l.innerText) })
    parts.push(e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('formcontrolname'), e.name, e.id)
    // the words just before it in its row (forms without <label>)
    var box = e.parentElement
    for (var up = 0; up < 3 && box; up++, box = box.parentElement) {
      var t = clean(box.innerText)
      if (t && t.length < 80) { parts.push(t); break }
    }
    return parts.filter(Boolean).map(function (p) { return clean(String(p).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')) }).join(' | ')
  }
  function keyOf(e) {
    var l = labelOf(e)
    if (!l || SKIP.test(l)) return null
    for (var i = 0; i < RULES.length; i++) {
      // test each part on its own so a long row of text does not mislead
      var parts = l.split(' | ')
      for (var j = 0; j < parts.length; j++) if (RULES[i][1].test(parts[j])) return RULES[i][0]
    }
    return null
  }
  function iso(v) {
    var m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/)
    if (m) return m[0]
    m = String(v).match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/)
    return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : v
  }
  var WORDS = { F: 'female', M: 'male', FEMALE: 'female', MALE: 'male' }
  function put(e, value) {
    var proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(e, value)
    e.dispatchEvent(new Event('input', { bubbles: true }))
    e.dispatchEvent(new Event('change', { bubbles: true }))
    e.dispatchEvent(new Event('blur', { bubbles: true }))
  }
  function pickOption(sel, value) {
    var want = String(WORDS[String(value).toUpperCase()] || value).toLowerCase().trim()
    if (!want) return false
    var best = null
    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i], t = (o.text || '').toLowerCase().trim(), v = (o.value || '').toLowerCase()
      if (!t || o.disabled) continue
      if (t === want || v === want) { best = o; break }
      if (!best && (t.indexOf(want) === 0 || want.indexOf(t) === 0 || t.indexOf(want) >= 0)) best = o
    }
    if (!best || sel.value === best.value) return false
    put(sel, best.value)
    return true
  }

  var touched = new WeakSet(), filled = new WeakSet()
  document.addEventListener('input', function (ev) { if (ev.isTrusted && ev.target) touched.add(ev.target) }, true)

  window.__adalFill = function (p) {
    p = p || window.__adalProfile || {}
    window.__adalProfile = p
    var n = 0
    var boxes = document.querySelectorAll('input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file]),select,textarea')
    for (var i = 0; i < boxes.length; i++) {
      var e = boxes[i]
      if (touched.has(e) || e.disabled || e.readOnly || !visible(e)) continue
      var key = keyOf(e)
      if (!key) continue
      var value = p[key]
      if (value == null || String(value).trim() === '') continue
      value = String(value).trim()
      try {
        if (e.tagName === 'SELECT') { if (pickOption(e, value)) { n++; filled.add(e) } else continue }
        else {
          if (e.value && !filled.has(e)) continue                   // something is already there
          if (e.type === 'date') value = iso(value)
          if (e.value === value) continue
          put(e, value); n++; filled.add(e)
        }
        e.style.outline = '2px solid #10b981'
        e.style.outlineOffset = '1px'
      } catch (x) {}
    }
    return n
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
