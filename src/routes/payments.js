import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { logPaymentAudit } from '../services/paymentAuditService.js';
import { generateInvoicePdf } from '../services/invoicePdfService.js';
import { verifyToken, SECRET_KEY } from './users.js';

const router = express.Router();
const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder',
);

// Helper: Process Payment Confirmation (Shared by PIX and Stripe)
const processPaymentConfirmation = async (
  memoryStore,
  {
    userId,
    amountBrl,
    credits,
    provider,
    providerId,
    cpfCnpj,
    adminId,
    bankStatus = 'CONFIRMED',
    bankResponse = null,
    failureReason = null,
  },
) => {
    // Check if transaction already exists
    if (!memoryStore.transactions) memoryStore.transactions = [];
    
    const existingTx = memoryStore.transactions.find(
      (t) => t.providerId === providerId && t.provider === provider,
    );
    if (existingTx) {
      console.log(`[Payment] Transaction already processed: ${providerId}`);
      return { transaction: existingTx, invoice: null };
    }

    const transaction = {
      id: uuidv4(),
      userId,
      amount: credits,
      amountBrl,
      type: 'grant',
      provider,
      providerId,
      status: bankStatus === 'CONFIRMED' ? 'paid' : 'failed',
      bankStatus,
      failureReason,
      createdAt: new Date().toISOString(),
      processedBy: adminId || 'system',
    };

    if (bankStatus !== 'CONFIRMED') {
      memoryStore.transactions.push(transaction);
      logPaymentAudit(memoryStore, {
        provider,
        type: 'confirmation',
        phase: 'bank_response',
        userId,
        orderId: providerId,
        transactionId: transaction.id,
        payload: { amountBrl, credits, cpfCnpj },
        bankStatus,
        bankResponse,
        status: 'rejected',
        errorMessage: failureReason,
      });
      if (memoryStore.save) memoryStore.save();
      return { transaction, invoice: null };
    }

    let invoiceData = null;
    try {
      invoiceData = await generateInvoicePdf({
        user: memoryStore.users?.get(userId),
        order: {
          userId,
          amountBrl,
          creditsExpected: credits,
          confirmedAt: new Date().toISOString(),
        },
        transaction,
        pixInfo: { cpfCnpj },
      });

      transaction.invoiceId = invoiceData.id;
      transaction.invoiceStatus = 'emitted';
      transaction.invoicePath = invoiceData.path;
      transaction.invoiceHash = invoiceData.hash;
      transaction.status = 'completed';

      if (!memoryStore.invoices) memoryStore.invoices = [];
      memoryStore.invoices.push({
        id: invoiceData.id,
        userId,
        provider,
        providerId,
        path: invoiceData.path,
        hash: invoiceData.hash,
        createdAt: invoiceData.createdAt,
      });

      if (memoryStore.users && typeof memoryStore.users.get === 'function') {
        const user = memoryStore.users.get(userId);
        if (user) {
          const currentCredits =
            typeof user.credits === 'number' && Number.isFinite(user.credits)
              ? user.credits
              : 0;
          user.credits = currentCredits + credits;
          memoryStore.users.set(userId, user);
          console.log(
            `[Credits] User ${userId} credited with ${credits}. Total: ${user.credits}`,
          );
        } else {
          console.warn(
            `[Credits] User not found while applying credits for transaction ${transaction.id}`,
          );
        }
      }

      if (memoryStore.payment_locks && memoryStore.payment_locks[userId]) {
        delete memoryStore.payment_locks[userId];
      }

      logPaymentAudit(memoryStore, {
        provider,
        type: 'confirmation',
        phase: 'completed',
        userId,
        orderId: providerId,
        transactionId: transaction.id,
        payload: { amountBrl, credits, cpfCnpj },
        bankStatus,
        bankResponse,
        status: 'accepted',
      });
    } catch (invError) {
      console.error('[Invoice] Error generating invoice:', invError);
      transaction.invoiceStatus = 'error';
      transaction.status = 'invoice_failed';

      logPaymentAudit(memoryStore, {
        provider,
        type: 'confirmation',
        phase: 'invoice_error',
        userId,
        orderId: providerId,
        transactionId: transaction.id,
        payload: { amountBrl, credits, cpfCnpj },
        bankStatus,
        bankResponse,
        status: 'error',
        errorMessage: invError.message,
      });
    }

    memoryStore.transactions.push(transaction);
    if (memoryStore.save) memoryStore.save();

    return { transaction, invoice: transaction.invoiceStatus === 'emitted' ? invoiceData : null };
};

// --- ACCESS CONTROL & ADMIN ENDPOINTS ---

// GET /api/payments/access-status?userId=...
// Returns whether user has a pending payment lock or can access features
router.get('/access-status', (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const locks = memoryStore.payment_locks || {};
    const lock = locks[userId];

    if (lock && lock.status === 'pending') {
      return res.json({
        success: true,
        data: {
          accessAllowed: false,
          reason: 'pending_payment',
          lock,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        accessAllowed: true,
        reason: null,
        lock: null,
      },
    });
  } catch (error) {
    console.error('[Access] Status Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// GET /api/payments/pix/pending (List Pending PIX Orders)
router.get('/pix/pending', (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const pendingOrders = (memoryStore.pix_payments || [])
      .filter(p => p.status === 'pending')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Newest first

    res.json({ success: true, data: pendingOrders });
  } catch (error) {
    console.error('[Admin] Get Pending PIX Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// GET /api/payments/transactions (List All Transactions)
router.get('/transactions', (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const transactions = (memoryStore.transactions || [])
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 100); // Limit to last 100

    res.json({ success: true, data: transactions });
  } catch (error) {
    console.error('[Admin] Get Transactions Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// --- PIX ENDPOINTS ---

// POST /api/payments/pix/order
router.post('/pix/order', (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const { userId, creditsPackage, amountBrl, cpfCnpj } = req.body;

    if (!userId || !creditsPackage || !amountBrl) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    if (!memoryStore.pix_payments) {
      memoryStore.pix_payments = [];
    }

    if (!memoryStore.payment_locks) {
      memoryStore.payment_locks = {};
    }

    const orderId = uuidv4();
    const pixKey = '41357540000104'; // CNPJ Key

    const pixOrder = {
      id: orderId,
      userId,
      amountBrl,
      creditsExpected: creditsPackage,
      pixKey,
      status: 'pending', // pending, confirmed, expired
      cpfCnpj: cpfCnpj || null, // Optional
      createdAt: new Date().toISOString()
    };

    memoryStore.pix_payments.push(pixOrder);
    memoryStore.payment_locks[userId] = {
      userId,
      provider: 'pix',
      providerOrderId: orderId,
      amountBrl,
      creditsExpected: creditsPackage,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    memoryStore.save();

    logPaymentAudit(memoryStore, {
      provider: 'pix',
      type: 'order',
      phase: 'created',
      userId,
      orderId,
      payload: { userId, creditsPackage, amountBrl, cpfCnpj },
      status: 'pending',
    });

    console.log(`[PIX] Order created: ${orderId} for User ${userId}`);

    res.json({
      success: true,
      data: {
        orderId,
        pixKey,
        amountBrl,
        instructions: 'Realize o pagamento para a chave CNPJ informada. Os créditos serão liberados após a confirmação.'
      }
    });

  } catch (error) {
    const memoryStore = req.app.locals.memoryStore;
    logPaymentAudit(memoryStore, {
      provider: 'pix',
      type: 'order',
      phase: 'error',
      userId: req.body?.userId,
      payload: req.body,
      status: 'error',
      errorMessage: error.message,
    });
    console.error('[PIX] Create Order Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// POST /api/payments/pix/confirm (Manual/Admin or Webhook)
router.post('/pix/confirm', async (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const { orderId, adminId, bankStatus, bankResponse, failureReason } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, error: 'Order ID required' });
    }

    const orderIndex = memoryStore.pix_payments.findIndex(p => p.id === orderId);
    if (orderIndex === -1) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const order = memoryStore.pix_payments[orderIndex];

    if (order.status === 'confirmed') {
      return res.status(400).json({ success: false, error: 'Order already confirmed' });
    }

    const effectiveBankStatus = bankStatus || 'CONFIRMED';

    if (effectiveBankStatus === 'CONFIRMED') {
      order.status = 'confirmed';
      order.confirmedAt = new Date().toISOString();
      order.confirmedBy = adminId || 'system';
    } else {
      order.status = 'failed';
      order.failedAt = new Date().toISOString();
      order.failureReason = failureReason || 'Bank declined or timeout';
    }
    memoryStore.save();

    const result = await processPaymentConfirmation(memoryStore, {
      userId: order.userId,
      amountBrl: order.amountBrl,
      credits: order.creditsExpected,
      provider: 'pix',
      providerId: orderId,
      cpfCnpj: order.cpfCnpj,
      adminId,
      bankStatus: effectiveBankStatus,
      bankResponse: bankResponse || null,
      failureReason: failureReason || null,
    });

    res.json({
      success: result.transaction.status === 'completed',
      data: {
        order,
        transaction: result.transaction,
        invoice: result.invoice,
      },
      error:
        result.transaction.status === 'completed'
          ? null
          : 'Pagamento não confirmado ou NF não emitida.',
    });
  } catch (error) {
    const memoryStore = req.app.locals.memoryStore;
    logPaymentAudit(memoryStore, {
      provider: 'pix',
      type: 'confirmation',
      phase: 'exception',
      orderId: req.body?.orderId,
      userId: null,
      payload: req.body,
      status: 'error',
      errorMessage: error.message,
    });
    console.error('[PIX] Confirm Order Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// --- STRIPE ENDPOINTS ---

// POST /api/payments/stripe/checkout-session
router.post('/stripe/checkout-session', async (req, res) => {
  try {
    const { userId, creditsPackage, amountBrl } = req.body;

    if (!userId || !creditsPackage || !amountBrl) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://app.canteeganhe.com';

    const memoryStore = req.app.locals.memoryStore;
    if (!memoryStore.payment_locks) {
      memoryStore.payment_locks = {};
    }

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      client_reference_id: userId,
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: {
              name: `${creditsPackage} Músicas`,
              description: 'Créditos para geração de música por IA',
            },
            unit_amount: Math.round(amountBrl * 100), // Stripe expects cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${frontendUrl}/#/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/#/dashboard`,
      metadata: {
        credits: creditsPackage,
        amountBrl
      },
    });

    memoryStore.payment_locks[userId] = {
      userId,
      provider: 'stripe',
      providerOrderId: session.id,
      amountBrl,
      creditsExpected: creditsPackage,
      status: 'pending',
      createdAt: new Date().toISOString(),
      checkoutUrl: session.url,
    };
    if (memoryStore.save) memoryStore.save();

    res.json({ success: true, url: session.url });
  } catch (error) {
    console.error('[Stripe] Create Session Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- STRIPE WEBHOOK ---
router.post('/webhook/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        if (endpointSecret && sig) {
            // Verify signature using raw body
            if (!req.rawBody) {
                return res.status(400).send('Webhook Error: Raw body not available');
            }
            event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
        } else {
            // Dev Mode / No Secret: Trust the body (Not safe for production!)
            // Useful for testing with 'stripe trigger' CLI without secret sync or simple mocks
            console.warn('[Stripe] Webhook signature verification skipped (Missing Secret or Signature)');
            event = req.body;
        }
    } catch (err) {
        console.error(`[Stripe] Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        console.log('[Stripe] Session Completed:', session.id);

        const memoryStore = req.app.locals.memoryStore;
        
        // Extract Data
        // client_reference_id should be the userId
        const userId = session.client_reference_id; 
        const amountBrl = session.amount_total ? session.amount_total / 100 : 0; // Cents to Unit
        
        // Metadata usually contains 'credits' if we added it during Checkout creation
        // If not, we might need to infer from amount or productId.
        // For this implementation, we assume metadata.credits is present.
        const credits = session.metadata?.credits ? parseInt(session.metadata.credits) : 0;
        const cpfCnpj = session.metadata?.cpfCnpj || null;

        if (userId) {
             await processPaymentConfirmation(memoryStore, {
                userId,
                amountBrl,
                credits: credits > 0 ? credits : 1,
                provider: 'stripe',
                providerId: session.id,
                cpfCnpj,
                bankStatus: 'CONFIRMED',
                bankResponse: { rawEventType: event.type },
            });
        } else {
            console.warn('[Stripe] Missing userId in session');
        }
    }

    res.json({received: true});
});

// --- INVOICE DOWNLOAD ---

// GET /api/payments/invoices/:invoiceId/download
router.get('/invoices/:invoiceId/download', verifyToken, (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const { invoiceId } = req.params;

    if (!invoiceId) {
      return res
        .status(400)
        .json({ success: false, error: 'Invoice ID is required' });
    }

    const invoiceRecord = (memoryStore.invoices || []).find(
      (inv) => inv.id === invoiceId,
    );

    if (!invoiceRecord) {
      return res
        .status(404)
        .json({ success: false, error: 'Invoice not found' });
    }

    if (invoiceRecord.userId !== req.userId && req.userRole !== 'master') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: you do not have access to this invoice',
      });
    }

    res.download(invoiceRecord.path, `${invoiceId}.pdf`);
  } catch (error) {
    console.error('[Invoice] Download Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// GET /api/payments/invoices/:invoiceId/public?token=JWT
router.get('/invoices/:invoiceId/public', (req, res) => {
  try {
    const { invoiceId } = req.params;
    const token = req.query.token;

    if (!invoiceId) {
      return res
        .status(400)
        .json({ success: false, error: 'Invoice ID is required' });
    }

    if (!token || typeof token !== 'string') {
      return res
        .status(401)
        .json({ success: false, error: 'Token is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, SECRET_KEY);
    } catch (err) {
      return res
        .status(401)
        .json({ success: false, error: 'Invalid or expired token' });
    }

    const memoryStore = req.app.locals.memoryStore;
    const invoiceRecord = (memoryStore.invoices || []).find(
      (inv) => inv.id === invoiceId,
    );

    if (!invoiceRecord) {
      return res
        .status(404)
        .json({ success: false, error: 'Invoice not found' });
    }

    if (
      invoiceRecord.userId !== decoded.id &&
      decoded.role !== 'master'
    ) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: you do not have access to this invoice',
      });
    }

    res.download(invoiceRecord.path, `${invoiceId}.pdf`);
  } catch (error) {
    console.error('[Invoice] Public Download Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

export { processPaymentConfirmation };

// DELETE /api/payments/pix/:orderId (Admin Master only)
router.delete('/pix/:orderId', (req, res) => {
  const { orderId } = req.params;
  const { adminId } = req.body; // In a real app, use middleware auth

  if (!adminId) {
    return res.status(403).json({ error: 'Unauthorized: Admin ID required' });
  }

  // TODO: Verify if adminId is actually a Master admin (mocked here or check DB)
  // For MVP, assuming frontend checks role, but backend should too.

  try {
    const memoryStore = req.app.locals.memoryStore;
    
    const index = (memoryStore.pix_payments || []).findIndex(p => p.id === orderId);
    if (index === -1) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = memoryStore.pix_payments[index];
    if (order.status === 'confirmed') {
      return res.status(400).json({ error: 'Cannot delete a paid order' });
    }

    // Remove from array
    memoryStore.pix_payments.splice(index, 1);
    memoryStore.save();

    console.log(`[Payment] PIX order ${orderId} deleted by admin ${adminId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting PIX order:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
