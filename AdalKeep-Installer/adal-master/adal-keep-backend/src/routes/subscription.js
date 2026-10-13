import express from 'express'
import crypto from 'crypto'

const router = express.Router()

/**
 * POST /api/subscription/activate-trial
 * Called on first launch. Server records trial start.
 */
router.post('/activate-trial', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { fingerprint, client_name } = req.body

    if (!fingerprint) {
      return res.status(400).json({ error: 'Fingerprint required' })
    }

    // Check if already exists
    const existing = await db('subscriptions').where('fingerprint', fingerprint).first()
    if (existing) {
      return res.json({
        status: existing.status,
        trial_end: existing.trial_end,
        paid_until: existing.paid_until,
        days_remaining: existing.status === 'trial'
          ? Math.max(0, Math.ceil((new Date(existing.trial_end) - new Date()) / 86400000))
          : null
      })
    }

    // Create new trial
    const now = new Date()
    const trialEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

    await db('subscriptions').insert({
      fingerprint,
      client_name: client_name || 'Unknown',
      plan: 'monthly',
      trial_start: now.toISOString(),
      trial_end: trialEnd.toISOString(),
      status: 'trial',
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    })

    res.json({
      status: 'trial',
      trial_end: trialEnd.toISOString(),
      days_remaining: 30
    })
  } catch (err) {
    console.error('Trial activation error:', err)
    res.status(500).json({ error: 'Failed to activate trial' })
  }
})

/**
 * GET /api/subscription/status
 * Check subscription status (called on every app start + periodically)
 */
router.get('/status', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { fingerprint } = req.query

    if (!fingerprint) {
      return res.status(400).json({ error: 'Fingerprint required' })
    }

    const sub = await db('subscriptions').where('fingerprint', fingerprint).first()

    if (!sub) {
      return res.json({ status: 'not_found', locked: true })
    }

    const now = new Date()

    // Calculate remaining days
    let daysRemaining = 0
    let locked = false

    if (sub.status === 'trial') {
      const trialEnd = new Date(sub.trial_end)
      daysRemaining = Math.max(0, Math.ceil((trialEnd - now) / 86400000))
      if (daysRemaining <= 0) {
        // Trial expired — update status
        await db('subscriptions').where('id', sub.id).update({
          status: 'expired',
          updated_at: now.toISOString()
        })
        sub.status = 'expired'
        locked = true
      }
    } else if (sub.status === 'active' && sub.paid_until) {
      const paidUntil = new Date(sub.paid_until)
      daysRemaining = Math.max(0, Math.ceil((paidUntil - now) / 86400000))
      if (daysRemaining <= 0) {
        await db('subscriptions').where('id', sub.id).update({
          status: 'expired',
          updated_at: now.toISOString()
        })
        sub.status = 'expired'
        locked = true
      }
    } else if (sub.status === 'expired' || sub.status === 'locked') {
      locked = true
    }

    res.json({
      status: sub.status,
      days_remaining: daysRemaining,
      locked,
      plan: sub.plan,
      client_name: sub.client_name,
      trial_end: sub.trial_end,
      paid_until: sub.paid_until
    })
  } catch (err) {
    console.error('Status check error:', err)
    res.status(500).json({ error: 'Failed to check status' })
  }
})

/**
 * POST /api/subscription/submit-payment
 * Client submits telebirr/CBE reference after paying
 */
router.post('/submit-payment', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { fingerprint, payment_ref, method, amount } = req.body

    if (!fingerprint || !payment_ref || !method) {
      return res.status(400).json({ error: 'All fields required' })
    }

    const sub = await db('subscriptions').where('fingerprint', fingerprint).first()
    if (!sub) {
      return res.status(404).json({ error: 'Subscription not found' })
    }

    // Record payment (unverified until admin approves)
    await db('subscription_payments').insert({
      subscription_id: sub.id,
      payment_ref: payment_ref.trim(),
      method,
      amount: amount || 0,
      verified: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    // Update subscription status to pending_approval
    await db('subscriptions').where('id', sub.id).update({
      status: 'pending_approval',
      payment_ref: payment_ref.trim(),
      updated_at: new Date().toISOString()
    })

    res.json({
      success: true,
      message: 'ክፍያዎ ተመዝግቧል። አስተዳዳሪ ካረጋገጠ በኋላ ይከፈታል።',
      status: 'pending_approval'
    })
  } catch (err) {
    console.error('Payment submission error:', err)
    res.status(500).json({ error: 'Failed to submit payment' })
  }
})

/**
 * POST /api/subscription/admin/approve
 * Admin approves a payment (called from YOUR dashboard)
 */
router.post('/admin/approve', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { payment_id, days = 30 } = req.body

    if (!payment_id) {
      return res.status(400).json({ error: 'Payment ID required' })
    }

    const payment = await db('subscription_payments').where('id', payment_id).first()
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' })
    }

    const now = new Date()
    const paidUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

    // Mark payment as verified
    await db('subscription_payments').where('id', payment_id).update({
      verified: true,
      verified_at: now.toISOString(),
      updated_at: now.toISOString()
    })

    // Activate subscription
    await db('subscriptions').where('id', payment.subscription_id).update({
      status: 'active',
      paid_until: paidUntil.toISOString(),
      approved: true,
      updated_at: now.toISOString()
    })

    res.json({
      success: true,
      message: `Subscription activated for ${days} days`,
      paid_until: paidUntil.toISOString()
    })
  } catch (err) {
    console.error('Approval error:', err)
    res.status(500).json({ error: 'Failed to approve' })
  }
})

/**
 * GET /api/subscription/admin/pending
 * List all pending payments for admin dashboard
 */
router.get('/admin/pending', async (req, res) => {
  try {
    const db = req.app.locals.db
    const pending = await db('subscription_payments')
      .join('subscriptions', 'subscription_payments.subscription_id', 'subscriptions.id')
      .where('subscription_payments.verified', false)
      .select(
        'subscription_payments.id as payment_id',
        'subscription_payments.payment_ref',
        'subscription_payments.method',
        'subscription_payments.amount',
        'subscription_payments.created_at',
        'subscriptions.fingerprint',
        'subscriptions.client_name',
        'subscriptions.status as sub_status'
      )
      .orderBy('subscription_payments.created_at', 'desc')

    res.json(pending)
  } catch (err) {
    console.error('Pending payments error:', err)
    res.status(500).json({ error: 'Failed to fetch pending' })
  }
})

export default router