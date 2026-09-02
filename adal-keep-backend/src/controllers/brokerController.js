import knex from 'knex'
import knexConfig from '../../knexfile.js'

// Force the exact same database the rest of the app uses
const db = knex(knexConfig.development)

export async function listBrokers(req, res) {
  try {
    const brokers = await db('brokers').select('*').orderBy('name')
    res.json(brokers)
  } catch (err) {
    console.error('[listBrokers]', err)
    res.status(500).json({ error: 'Failed to load brokers' })
  }
}

export async function createBroker(req, res) {
  try {
    console.log('========== CREATE BROKER ==========')
    console.log('Body received:', JSON.stringify(req.body, null, 2))
    console.log('Auth:', req.auth)

    const { name, logo, address, contact1, contact2, notes, created_by } = req.body

    if (!name?.trim()) {
      return res.status(400).json({ error: 'የደላላ ስም ያስፈልጋል' })
    }

    const data = {
      name: name.trim(),
      logo: logo || null,
      address: address || null,
      contact1: contact1 || null,
      contact2: contact2 || null,
      notes: notes || null,
      company_id: req.auth?.companyId || null,
      created_by: (created_by || '').toString().trim() || null
    }

    console.log('About to insert:', data)

    const [id] = await db('brokers').insert(data)
    console.log('Inserted with id:', id)

    const broker = await db('brokers').where({ id }).first()
    console.log('Saved broker:', broker)
    console.log('===================================')

    res.status(201).json(broker)
  } catch (err) {
    console.error('[createBroker ERROR]', err)
    res.status(500).json({ error: 'ደላላ መፍጠር አልተቻለም: ' + err.message })
  }
}

export async function updateBroker(req, res) {
  try {
    const { id } = req.params
    const { name, logo, address, contact1, contact2, notes } = req.body
    await db('brokers').where({ id }).update({
      name, logo, address, contact1, contact2, notes,
      updated_at: db.fn.now()
    })
    const broker = await db('brokers').where({ id }).first()
    res.json(broker)
  } catch (err) {
    res.status(500).json({ error: 'ማዘመን አልተቻለም' })
  }
}

export async function deleteBroker(req, res) {
  try {
    await db('brokers').where({ id: req.params.id }).del()
    res.json({ message: 'Broker deleted' })
  } catch (err) {
    res.status(500).json({ error: 'መሰረዝ አልተቻለም' })
  }
}

export async function assignBroker(req, res) {
  const profileId = Number(req.body.profileId ?? req.body.profile_id)
  const brokerId = Number(req.body.brokerId ?? req.body.broker_id)
  if (!profileId || !brokerId) {
    return res.status(400).json({ error: 'profileId and brokerId required' })
  }
  await db('profiles').where({ id: profileId }).update({
    broker_id: brokerId,
    updated_at: db.fn.now()
  })
  res.json({ message: 'Assigned', profileId, brokerId })
}

export async function unassignBroker(req, res) {
  const { profileId } = req.body
  await db('profiles').where({ id: profileId }).update({ broker_id: null })
  res.json({ message: 'Unassigned' })
}
