import crypto from 'crypto'

const SECRET = process.env.TENANT_SECRET || 'adal-keep-local-secret'

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 365 * 86400000 })).toString('base64url')
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`
}
export function verifyToken(token) {
  if (!token) return null
  try {
    const [body, sig] = token.split('.')
    if (sig !== crypto.createHmac('sha256', SECRET).update(body).digest('base64url')) return null
    const d = JSON.parse(Buffer.from(body, 'base64url').toString())
    return d.exp > Date.now() ? d : null
  } catch { return null }
}

async function ensureCol(db, table, column, fn) {
  if (!(await db.schema.hasColumn(table, column))) await db.schema.table(table, fn)
}

export async function ensureTenancySchema(db) {
  if (!(await db.schema.hasTable('companies'))) {
    await db.schema.createTable('companies', t => {
      t.increments('id').primary(); t.string('name'); t.string('owner_name')
      t.string('phone1'); t.string('phone2'); t.string('phone3')
      t.string('intake_whatsapp_number'); t.string('api_key_name'); t.string('api_key')
      t.timestamps(true, true)
    })
  }
  if (!(await db.schema.hasTable('branches'))) {
    await db.schema.createTable('branches', t => {
      t.increments('id').primary(); t.integer('company_id'); t.string('name'); t.string('location')
      t.timestamps(true, true)
    })
  }
  if (!(await db.schema.hasTable('users'))) {
    await db.schema.createTable('users', t => {
      t.increments('id').primary(); t.string('username'); t.string('password'); t.string('name')
      t.string('role').defaultTo('employee'); t.integer('company_id').nullable(); t.integer('branch_id').nullable()
      t.string('phone_whatsapp'); t.string('phone_work'); t.integer('whatsapp_linked').defaultTo(0)
      t.timestamps(true, true)
    })
  } else {
    for (const [c, fn] of [['name', t => t.string('name')], ['role', t => t.string('role').defaultTo('employee')], ['company_id', t => t.integer('company_id').nullable()], ['branch_id', t => t.integer('branch_id').nullable()], ['phone_whatsapp', t => t.string('phone_whatsapp')], ['phone_work', t => t.string('phone_work')], ['whatsapp_linked', t => t.integer('whatsapp_linked').defaultTo(0)], ['password', t => t.string('password')]]) {
      await ensureCol(db, 'users', c, fn)
    }
  }
  if (await db.schema.hasTable('profiles')) {
    await ensureCol(db, 'profiles', 'company_id', t => t.integer('company_id').nullable())
    await ensureCol(db, 'profiles', 'branch_id', t => t.integer('branch_id').nullable())
  }
  if (await db.schema.hasTable('brokers')) await ensureCol(db, 'brokers', 'company_id', t => t.integer('company_id').nullable())
  if (!(await db.schema.hasTable('notifications'))) {
    await db.schema.createTable('notifications', t => {
      t.increments('id').primary(); t.integer('company_id').nullable(); t.string('type'); t.string('title'); t.text('body')
      t.string('created_day'); t.timestamps(true, true)
    })
  }
}

// Link orphan data to the company created by the wizard (handles your Mac migration)
export async function adoptOrphanData(db, companyId, branchId) {
  await db('profiles').whereNull('company_id').update({ company_id: companyId, branch_id: branchId })
  if (await db.schema.hasTable('brokers')) await db('brokers').whereNull('company_id').update({ company_id: companyId })
  await db('users').whereNull('company_id').where('role', '!=', 'employee').update({ company_id: companyId, branch_id: branchId })
}
