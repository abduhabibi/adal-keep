import db from '../config/database.js'

export async function listBrokers(req, res) {
  const brokers = await db('brokers').select('*').orderBy('name')
  res.json(brokers)
}

export async function createBroker(req, res) {
  const { name, logo, address, contact1, contact2 } = req.body
  const [broker] = await db('brokers')
    .insert({ name, logo, address, contact1, contact2 })
    .returning('*')
  res.status(201).json(broker)
}

export async function updateBroker(req, res) {
  const { id } = req.params
  const { name, logo, address, contact1, contact2 } = req.body
  await db('brokers')
    .where({ id })
    .update({ name, logo, address, contact1, contact2, updated_at: db.fn.now() })
  const broker = await db('brokers').where({ id }).first()
  res.json(broker)
}

export async function deleteBroker(req, res) {
  const { id } = req.params
  await db('brokers').where({ id }).del()
  res.json({ message: 'Broker deleted' })
}

export async function assignBroker(req, res) {
  const { profileId, brokerId } = req.body
  await db('profiles').where({ id: profileId }).update({ broker_id: brokerId })
  // Also update the 'Broker ID' permanent field for consistency
  const brokerField = await db('profile_fields')
    .where({ profile_id: profileId, name: 'Broker ID' }).first()
  if (brokerField) {
    await db('profile_fields')
      .where({ id: brokerField.id })
      .update({ value_text: brokerId ? String(brokerId) : null })
  }
  res.json({ message: 'Assigned' })
}

export async function unassignBroker(req, res) {
  const { profileId } = req.body
  await db('profiles').where({ id: profileId }).update({ broker_id: null })
  // Also clear the Broker ID field
  const brokerField = await db('profile_fields')
    .where({ profile_id: profileId, name: 'Broker ID' }).first()
  if (brokerField) {
    await db('profile_fields').where({ id: brokerField.id }).update({ value_text: null })
  }
  res.json({ message: 'Unassigned' })
}