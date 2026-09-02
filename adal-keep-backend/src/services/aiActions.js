import aiService from './ai.js'

function stripQuotes(s) {
  return String(s || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim()
}

function isBare(msg, kind) {
  const m = msg.trim()
  if (kind === 'profile') return /^(create\s+(a\s+)?profile|አዲስ\s*ፕሮፋይል|ፕሮፋይል\s*ፍጠር)$/i.test(m)
  if (kind === 'broker') return /^(create\s+(a\s+)?(broker|facilitator)|አመቻች\s*ፍጠር|ደላላ\s*ፍጠር)$/i.test(m)
  if (kind === 'employee') return /^(create\s+(an?\s+)?employee|ሰራተኛ\s*ፍጠር)$/i.test(m)
  if (kind === 'task') return /^(create\s+(a\s+)?task|ተግባር(\s*ፍጠር)?|goal)$/i.test(m)
  if (kind === 'checklist') return /^(create\s+(a\s+)?checklist|ክትትል(\s*ፍጠር)?)$/i.test(m)
  if (kind === 'notification') return /^(create\s+(a\s+)?notifications?|ማሳወቂያ(\s*ፍጠር)?)$/i.test(m)
  return false
}

function phoneOk(p) {
  const d = String(p || '').replace(/\D/g, '')
  return d.length >= 9 && d.length <= 15
}

function extractAfter(msg, re) {
  const m = msg.match(re)
  return m ? stripQuotes(m[1]) : null
}

/** Parse "key: value" lines or simple patterns from user text into object */
function parseFields(msg) {
  const out = {}
  const text = String(msg || '')
  // key: value pairs
  for (const line of text.split(/[\n,;]+/)) {
    const m = line.match(/^\s*([a-zA-Z_\u1200-\u137F][a-zA-Z0-9_\u1200-\u137F\s]{0,40})\s*[:=\-]\s*(.+)\s*$/)
    if (m) {
      const k = m[1].trim().toLowerCase().replace(/\s+/g, '_')
      out[k] = stripQuotes(m[2])
    }
  }
  // common English / Amharic aliases → canonical
  const map = {
    full_name: ['full_name', 'name', 'ስም', 'fullname', 'fullname_name'],
    phone_number: ['phone', 'phone_number', 'ስልክ', 'tel', 'mobile'],
    passport_number: ['passport', 'passport_number', 'ፓስፖርት'],
    address: ['address', 'place', 'አድራሻ', 'location'],
    contact1: ['contact', 'contact1', 'phone'],
    username: ['username', 'user', 'login'],
    password: ['password', 'pass', 'የይለፍ'],
    title: ['title', 'ርዕስ'],
    body: ['body', 'message', 'ጽሁፍ'],
    national_id: ['national_id', 'id', 'ብሔራዊ']
  }
  const canonical = {}
  for (const [canon, aliases] of Object.entries(map)) {
    for (const a of aliases) {
      if (out[a]) canonical[canon] = out[a]
    }
  }
  // bare phone
  const ph = text.match(/(?:phone|ስልክ)\s*[:=\-]?\s*([+0-9\s\-]{9,18})/i)
  if (ph) canonical.phone_number = ph[1].replace(/\s/g, '')
  const pp = text.match(/(?:passport|ፓስፖርት)\s*[:=\-]?\s*([A-Z0-9]{5,15})/i)
  if (pp) canonical.passport_number = pp[1].toUpperCase()
  return { ...out, ...canonical }
}

export default class AIActions {
  constructor(db) {
    this.db = db
  }

  // -------- requirements (mirror manual forms) --------
  profileMissing(d) {
    const miss = []
    if (!d.full_name) miss.push('full_name (ስም)')
    if (!d.passport_number) miss.push('passport_number (ፓስፖርት)')
    if (!d.phone_number || !phoneOk(d.phone_number)) miss.push('phone_number (ስልክ፣ 9+ digits)')
    return miss
  }
  brokerMissing(d) {
    const miss = []
    if (!d.name && !d.full_name) miss.push('name (ስም)')
    if (!d.address && !d.place) miss.push('address (አድራሻ)')
    return miss
  }
  employeeMissing(d) {
    const miss = []
    if (!d.name && !d.full_name) miss.push('name')
    if (!d.username) miss.push('username')
    if (!d.password) miss.push('password')
    if (!d.phone_number && !d.phone) miss.push('phone')
    return miss
  }

  async processMessage(message, context = {}) {
    const msg = String(message || '').trim()
    const history = Array.isArray(context.history) ? context.history : []
    const prevA = String([...history].reverse().find(m => m.role === 'assistant')?.content || '')
    const prevU = String([...history].reverse().find(m => m.role === 'user')?.content || '')
    const fields = parseFields(msg)

    // ========== PROFILE ==========
    if (
      /create\s+(a\s+)?profile|አዲስ\s*ፕሮፋይል|ፕሮፋይል\s*ፍጠር/i.test(msg) ||
      (/ፕሮፋይል|profile/i.test(prevA) && /ስም|passport|ፓስፖርት|ስልክ|phone|full_name/i.test(prevA))
    ) {
      if (isBare(msg, 'profile')) {
        return {
          suggestion:
            'ፕሮፋይል ለመፍጠር እነዚህ ያስፈልጋሉ:\n' +
            '1) ስም (full_name)\n2) ፓስፖርት (passport_number)\n3) ስልክ (phone_number)\n\n' +
            'ለምሳሌ:\nfull_name: Abebe Kebede\npassport_number: EP1234567\nphone_number: 0911234567',
          pendingAction: null
        }
      }
      // merge name-only follow-up
      if (!fields.full_name && !/create /i.test(msg) && msg.length < 80 && !/passport|phone|ስልክ|ፓስፖርት/i.test(msg)) {
        fields.full_name = stripQuotes(msg)
      }
      // try pull from whole msg as name if only one line
      if (!fields.full_name && /create\s+(a\s+)?profile\s+(.+)/i.test(msg)) {
        fields.full_name = stripQuotes(msg.replace(/create\s+(a\s+)?profile\s+/i, ''))
      }

      const miss = this.profileMissing(fields)
      if (miss.length) {
        return {
          suggestion:
            `የሚከተሉት ጎድለዋል: ${miss.join(', ')}\n` +
            'እባክዎ ያሟሉ (በአንድ መልእክት መላክ ይችላሉ).',
          pendingAction: null
        }
      }
      return {
        suggestion:
          `ፕሮፋይል ዝግጁ:\n• ስም: ${fields.full_name}\n• ፓስፖርት: ${fields.passport_number}\n• ስልክ: ${fields.phone_number}\n\nአጽድቅ ይጫኑ።`,
        pendingAction: {
          type: 'create_profile',
          data: {
            full_name: fields.full_name,
            passport_number: fields.passport_number,
            phone_number: fields.phone_number,
            national_id: fields.national_id || null,
            gender: fields.gender || null,
            nationality: fields.nationality || null
          }
        }
      }
    }

    // ========== FACILITATOR / BROKER ==========
    if (
      /create\s+(a\s+)?(broker|facilitator)|አመቻች|ደላላ\s*ፍጠር/i.test(msg) ||
      (/አመቻች|facilitator|broker|ደላላ/i.test(prevA) && /ስም|አድራሻ|address|name/i.test(prevA))
    ) {
      if (isBare(msg, 'broker')) {
        return {
          suggestion:
            'አመቻች (facilitator) ለመፍጠር:\n1) ስም (name)\n2) አድራሻ (address)\nአማራጭ: ስልክ (contact1)\n\nለምሳሌ:\nname: Ahmed\naddress: Addis Ababa\ncontact1: 0911223344',
          pendingAction: null
        }
      }
      if (!fields.name && !fields.full_name && !/create /i.test(msg) && msg.length < 60) {
        fields.name = stripQuotes(msg)
      }
      fields.name = fields.name || fields.full_name
      fields.address = fields.address || fields.place
      fields.contact1 = fields.contact1 || fields.phone_number || fields.phone
      const miss = this.brokerMissing(fields)
      if (miss.length) {
        return { suggestion: `ጎድሏል: ${miss.join(', ')}`, pendingAction: null }
      }
      return {
        suggestion: `አመቻች ዝግጁ: ${fields.name} / ${fields.address}\nአጽድቅ ይጫኑ።`,
        pendingAction: {
          type: 'create_broker',
          data: {
            name: fields.name,
            address: fields.address,
            contact1: fields.contact1 || null
          }
        }
      }
    }

    // ========== EMPLOYEE ==========
    if (
      /create\s+(an?\s+)?employee|ሰራተኛ\s*ፍጠር/i.test(msg) ||
      (/ሰራተኛ|employee/i.test(prevA) && /username|password|ስም|phone/i.test(prevA))
    ) {
      if (isBare(msg, 'employee')) {
        return {
          suggestion:
            'ሰራተኛ ለመፍጠር:\n1) name\n2) username\n3) password\n4) phone\n\nለምሳሌ:\nname: Sara\nusername: sara1\npassword: secret123\nphone: 0911000000',
          pendingAction: null
        }
      }
      fields.name = fields.name || fields.full_name
      fields.phone = fields.phone || fields.phone_number
      const miss = this.employeeMissing({ ...fields, phone: fields.phone })
      if (miss.length) {
        return { suggestion: `ጎድሏል: ${miss.join(', ')}`, pendingAction: null }
      }
      return {
        suggestion: `ሰራተኛ ዝግጁ: ${fields.name} (@${fields.username})\nአጽድቅ ይጫኑ።`,
        pendingAction: {
          type: 'create_employee',
          data: {
            name: fields.name,
            username: fields.username,
            password: fields.password,
            phone_work: fields.phone,
            phone_work: fields.phone_work || fields.phone
          }
        }
      }
    }

    // ========== ADD PROFILE TO CHECKLIST ==========
    if (/add\s+(profile|.*)\s+to\s+checklist|checklist.*add|ወደ\s*ክትትል|ክትትል.*ጨምር/i.test(msg)) {
      return {
        suggestion:
          'ፕሮፋይል ወደ ክትትል ለመጨመር ይህን ይላኩ:\nchecklist_id: 1\nprofile_id: 5\nወይም checklist_name + profile_name',
        pendingAction: null
      }
    }
    if (fields.checklist_id && fields.profile_id) {
      return {
        suggestion: `ፕሮፋይል #${fields.profile_id} → ክትትል #${fields.checklist_id}\nአጽድቅ።`,
        pendingAction: {
          type: 'add_to_checklist',
          data: {
            checklist_id: Number(fields.checklist_id),
            profile_id: Number(fields.profile_id)
          }
        }
      }
    }

    // ========== DELETE CHECKLIST ==========
    if (/delete\s+(a\s+)?checklist|ክትትል\s*ሰርዝ|remove\s+checklist/i.test(msg)) {
      const id = extractAfter(msg, /checklist\s*(?:id\s*)?[:=]?\s*(\d+)/i) || fields.checklist_id || fields.id
      const name = extractAfter(msg, /checklist\s*[:\-]?\s*(.+)$/i)
      if (!id && !name) {
        return { suggestion: 'የትኛው ክትትል? checklist_id: 3 ወይም ስሙን ይጻፉ', pendingAction: null }
      }
      return {
        suggestion: `ክትትል መሰረዝ (${id || name}) — አጽድቅ። ፕሮፋይሎች አይሰረዙም።`,
        pendingAction: { type: 'delete_checklist', data: { id: id ? Number(id) : null, name: name || null } }
      }
    }

    // ========== NOTIFICATION ==========
    if (/create\s+(a\s+)?notifications?|ማሳወቂያ/i.test(msg) || (/ማሳወቂያ|notification/i.test(prevA) && /ርዕስ|title/i.test(prevA))) {
      if (isBare(msg, 'notification')) {
        return { suggestion: 'የማሳወቂያ ርዕስ/ጽሁፍ ይጻፉ', pendingAction: null }
      }
      let title = fields.title || fields.body
      if (!title && !/create /i.test(msg)) title = stripQuotes(msg)
      const q = msg.match(/["“](.+?)["”]/)
      if (q) title = q[1]
      if (!title || title.length < 2) {
        return { suggestion: 'የማሳወቂያ ርዕስ ይጻፉ', pendingAction: null }
      }
      return {
        suggestion: `ማሳወቂያ: «${title}» — አጽድቅ`,
        pendingAction: { type: 'create_notification', data: { title, body: fields.body || title } }
      }
    }

    // ========== CHECKLIST CREATE ==========
    if (/create\s+(a\s+)?checklist|ክትትል\s*ፍጠር/i.test(msg) || (/ክትትል|checklist/i.test(prevA) && /ስም|name/i.test(prevA))) {
      if (isBare(msg, 'checklist')) {
        return { suggestion: 'የክትትል ዝርዝር ስም?', pendingAction: null }
      }
      let name = fields.name || fields.title
      if (!name && !/create /i.test(msg)) name = stripQuotes(msg)
      if (!name) return { suggestion: 'ስም ያስፈልጋል', pendingAction: null }
      return {
        suggestion: `ክትትል: «${name}» — አጽድቅ`,
        pendingAction: { type: 'create_checklist', data: { name } }
      }
    }

    // ========== TASK ==========
    if (/create\s+(a\s+)?task|ተግባር/i.test(msg) || (/ተግባር|task/i.test(prevA) && /ርዕስ|title/i.test(prevA))) {
      if (isBare(msg, 'task')) {
        return { suggestion: 'የተግባር ርዕስ?', pendingAction: null }
      }
      let title = fields.title || fields.name
      if (!title) {
        const m = msg.match(/create\s+(?:a\s+)?task\s+(.+)$/i)
        if (m) title = stripQuotes(m[1])
      }
      if (!title && !/create /i.test(msg)) title = stripQuotes(msg)
      if (!title) return { suggestion: 'ርዕስ?', pendingAction: null }
      return {
        suggestion: `ተግባር: «${title}» — አጽድቅ`,
        pendingAction: { type: 'create_task', data: { title, description: fields.description || '' } }
      }
    }

    // ========== DELETE TASK ==========
    if (/delete\s+(a\s+)?task|ተግባር\s*ሰርዝ/i.test(msg)) {
      const id = extractAfter(msg, /task\s*(?:id\s*)?[:=]?\s*(\d+)/i) || fields.id
      if (!id) return { suggestion: 'task id ያስፈልጋል (ለምሳሌ delete task 76)', pendingAction: null }
      return {
        suggestion: `ተግባር #${id} ይሰረዝ? አጽድቅ`,
        pendingAction: { type: 'delete_task', data: { id: Number(id) } }
      }
    }

    // ========== LLM fallback — privileged but must emit action ==========
    let live = { profiles: 0, brokers: 0, tasks: 0, checklists: 0 }
    try {
      const [p] = await this.db('profiles').count('id as c')
      const [b] = await this.db('brokers').count('id as c')
      const [t] = await this.db('tasks').count('id as c')
      const [c] = await this.db('checklists').count('id as c')
      live = { profiles: +p.c || 0, brokers: +b.c || 0, tasks: +t.c || 0, checklists: +c.c || 0 }
    } catch {}

    const system = `You are Adal Keep AI with FULL ability to propose DB actions (user must approve).
Reply short Amharic. NEVER say "created" unless you output an action block.

Required fields:
- create_profile: full_name, passport_number, phone_number
- create_broker (facilitator/አመቻች): name, address; optional contact1
- create_employee: name, username, password, phone
- create_task: title
- create_checklist: name
- create_notification: title, body
- add_to_checklist: checklist_id, profile_id
- delete_checklist: id or name
- delete_task: id

Live counts: ${JSON.stringify(live)}

Action format only:
\`\`\`action
{"type":"create_profile","data":{"full_name":"...","passport_number":"...","phone_number":"..."}}
\`\`\`

If data missing, ask for missing fields only — one short message.`

    const hist = history.slice(-8).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 1200)
    }))

    const result = await aiService.chat(
      [{ role: 'system', content: system }, ...hist, { role: 'user', content: msg.slice(0, 3000) }],
      { temperature: 0.2, maxTokens: 700 }
    )
    if (!result.success) {
      return { suggestion: result.suggestion || 'ይቅርታ፣ አሁን ማገልገል አልቻልኩም።', pendingAction: null }
    }
    let suggestion = result.message || ''
    let pendingAction = null
    const match = suggestion.match(/```(?:action|json)\s*([\s\S]*?)```/)
    if (match) {
      try {
        const parsed = JSON.parse(match[1].trim())
        pendingAction = parsed.type ? parsed : { type: parsed.action, data: parsed.data || {} }
        // validate profile before showing approve
        if (pendingAction.type === 'create_profile') {
          const miss = this.profileMissing(pendingAction.data || {})
          if (miss.length) {
            return { suggestion: `ጎድሏል: ${miss.join(', ')}`, pendingAction: null }
          }
        }
        suggestion = suggestion.replace(/```(?:action|json)[\s\S]*?```/, '').trim() || 'እርምጃ ዝግጁ — አጽድቅ ይጫኑ።'
      } catch {}
    }
    // strip false success claims without action
    if (!pendingAction && /ተፈጥሯል|created successfully/i.test(suggestion) && /profile|ፕሮፋይል|task|ተግባር/i.test(suggestion)) {
      suggestion = 'እርምጃ ለማረጋገጥ ሙሉ መረጃ ያስፈልጋል። ያጎድሉትን ይላኩ።'
    }
    return { suggestion, pendingAction, model: result.model }
  }

  async executeAction(action, reqContext = {}) {
    const { type, data = {} } = action || {}
    const db = this.db
    const userId = reqContext.userId || null
    const now = () => new Date().toISOString()

    if (type === 'create_profile') {
      const miss = this.profileMissing(data)
      if (miss.length) return { success: false, message: 'ጎድሏል: ' + miss.join(', ') }
      const cols = await db('profiles').columnInfo()
      const row = {
        full_name: data.full_name,
        passport_number: data.passport_number,
        phone_number: data.phone_number,
        national_id: data.national_id || null,
        gender: data.gender || null,
        nationality: data.nationality || null,
        status: 'in_progress',
        created_by: 'AI',
        is_ai_created: 1,
        created_at: now(),
        updated_at: now()
      }
      const insert = {}
      for (const [k, v] of Object.entries(row)) if (cols[k] !== undefined) insert[k] = v
      const [id] = await db('profiles').insert(insert)
      return { success: true, id, message: `ፕሮፋይል ተፈጥሯል፡ ${data.full_name} (#${id}) — በፕሮፋይሎች ገጽ ይመልከቱ` }
    }

    if (type === 'create_broker') {
      if (!data.name || !(data.address || data.place)) {
        return { success: false, message: 'ስም እና አድራሻ ያስፈልጋሉ' }
      }
      const cols = await db('brokers').columnInfo()
      const row = {
        name: data.name,
        address: data.address || data.place,
        contact1: data.contact1 || data.phone || null,
        created_by: userId,
        created_at: now(),
        updated_at: now()
      }
      const insert = {}
      for (const [k, v] of Object.entries(row)) if (cols[k] !== undefined) insert[k] = v
      const [id] = await db('brokers').insert(insert)
      return { success: true, id, message: `አመቻች ተፈጥሯል፡ ${data.name} (#${id})` }
    }

    if (type === 'create_employee') {
      const miss = this.employeeMissing(data)
      if (miss.length) return { success: false, message: 'ጎድሏል: ' + miss.join(', ') }
      const cols = await db('users').columnInfo()
      let password = data.password
      // hash if bcrypt available and column is password_hash
      try {
        if (cols.password_hash) {
          const bcrypt = (await import('bcryptjs')).default
          password = await bcrypt.hash(String(data.password), 8)
        }
      } catch {}
      const row = {
        name: data.name,
        username: data.username,
        password: cols.password_hash ? undefined : data.password,
        password_hash: cols.password_hash ? password : undefined,
        role: data.role || 'employee',
        phone_work: data.phone || null,
        phone_work: data.phone_work || data.phone || null,
        created_at: now(),
        updated_at: now()
      }
      const insert = {}
      for (const [k, v] of Object.entries(row)) {
        if (v !== undefined && cols[k] !== undefined) insert[k] = v
      }
      const [id] = await db('users').insert(insert)
      return { success: true, id, message: `ሰራተኛ ተፈጥሯል፡ ${data.name} (#${id})` }
    }

    if (type === 'create_task') {
      const title = stripQuotes(data.title || data.name || '')
      if (!title) return { success: false, message: 'ርዕስ ያስፈልጋል' }
      const cols = await db('tasks').columnInfo()
      const row = {
        title,
        description: data.description || '',
        type: 'manual',
        status: 'pending',
        priority: data.priority || 'medium',
        is_ai_created: 1,
        created_by: 'AI',
        created_at: now(),
        updated_at: now()
      }
      const insert = {}
      for (const [k, v] of Object.entries(row)) if (cols[k] !== undefined) insert[k] = v
      const [id] = await db('tasks').insert(insert)
      return { success: true, id, message: `ተግባር ተፈጥሯል፡ ${title} (#${id})` }
    }

    if (type === 'create_checklist') {
      const name = stripQuotes(data.name || '')
      if (!name) return { success: false, message: 'ስም ያስፈልጋል' }
      const [id] = await db('checklists').insert({ name, created_at: now(), updated_at: now() })
      return { success: true, id, message: `ክትትል ተፈጥሯል፡ ${name} (#${id})` }
    }

    if (type === 'create_notification') {
      const title = stripQuotes(data.title || data.message || '')
      if (!title) return { success: false, message: 'ርዕስ ያስፈልጋል' }
      const cols = await db('notifications').columnInfo()
      const row = {
        title,
        body: data.body || title,
        type: data.type || 'ai_notification',
        company_id: 1,
        created_day: new Date().toISOString().slice(0, 10),
        created_at: now(),
        updated_at: now()
      }
      const insert = {}
      for (const [k, v] of Object.entries(row)) if (cols[k] !== undefined) insert[k] = v
      const [id] = await db('notifications').insert(insert)
      return { success: true, id, message: `ማሳወቂያ ተፈጥሯል፡ ${title} (#${id})` }
    }

    if (type === 'add_to_checklist') {
      const checklist_id = Number(data.checklist_id)
      const profile_id = Number(data.profile_id)
      if (!checklist_id || !profile_id) return { success: false, message: 'checklist_id እና profile_id ያስፈልጋሉ' }
      const exists = await db('checklist_profiles').where({ checklist_id, profile_id }).first()
      if (!exists) {
        await db('checklist_profiles').insert({ checklist_id, profile_id })
      }
      return { success: true, message: `ፕሮፋይል #${profile_id} ወደ ክትትል #${checklist_id} ተጨመረ` }
    }

    if (type === 'delete_checklist') {
      let id = data.id ? Number(data.id) : null
      if (!id && data.name) {
        const row = await db('checklists').where('name', data.name).first()
        id = row?.id
      }
      if (!id) return { success: false, message: 'ክትትል አልተገኘም' }
      await db('checklist_profiles').where({ checklist_id: id }).del()
      await db('checklists').where({ id }).del()
      return { success: true, message: `ክትትል #${id} ተሰርዟል (ፕሮፋይሎች አልተሰረዙም)` }
    }

    if (type === 'delete_task') {
      const id = Number(data.id)
      if (!id) return { success: false, message: 'id ያስፈልጋል' }
      await db('tasks').where({ id }).del()
      return { success: true, message: `ተግባር #${id} ተሰርዟል` }
    }

    return { success: false, message: 'Unknown action: ' + type }
  }
}
