import express from 'express';
const router = express.Router();

// Mock merchant balance (Replace with your actual database logic)
let merchantBalance = 50000; 

router.post('/receive-fayda', async (req, res) => {
  try {
    const { faydaId, amount } = req.body;
    
    if (!faydaId || !amount) {
      return res.status(400).json({ error: 'Fayda ID and amount are required' });
    }

    // TODO: Integrate actual Fayda API / Bank API here to deduct from customer
    // For now, we simulate a successful deduction and credit to the merchant
    
    merchantBalance += Number(amount);
    
    console.log(`[PAYMENT] ✅ Received ${amount} Birr from Fayda ID: ${faydaId}`);
    
    res.json({ 
      success: true, 
      message: `Successfully received ${amount} Birr`,
      newBalance: merchantBalance,
      transactionId: 'TXN-' + Date.now()
    });
  } catch (err) {
    console.error('[PAYMENT ERROR]', err);
    res.status(500).json({ error: 'Transaction failed' });
  }
});

export default router;
