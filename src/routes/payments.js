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

const persistTransactionToDb = async (pool, transaction) => {
  if (!pool) {
    return;
  }
  const createdAt =
    transaction.createdAt && !Number.isNaN(new Date(transaction.createdAt).getTime())
      ? transaction.createdAt
      : new Date().toISOString();
  await pool.query(
    `
      insert into payment_transactions (
        id,
        user_id,
        amount,
        amount_brl,
        type,
        provider,
        provider_id,
        status,
        bank_status,
        failure_reason,
        created_at,
        processed_by,
        invoice_id,
        invoice_status,
        invoice_path,
        invoice_hash,
        invoice_handled,
        archived
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
      )
      on conflict (id) do update set
        user_id = excluded.user_id,
        amount = excluded.amount,
        amount_brl = excluded.amount_brl,
        type = excluded.type,
        provider = excluded.provider,
        provider_id = excluded.provider_id,
        status = excluded.status,
        bank_status = excluded.bank_status,
        failure_reason = excluded.failure_reason,
        created_at = excluded.created_at,
        processed_by = excluded.processed_by,
        invoice_id = excluded.invoice_id,
        invoice_status = excluded.invoice_status,
        invoice_path = excluded.invoice_path,
        invoice_hash = excluded.invoice_hash,
        invoice_handled = excluded.invoice_handled,
        archived = excluded.archived
    `,
    [
      transaction.id,
      transaction.userId || null,
      typeof transaction.amount === 'number' ? transaction.amount : null,
      typeof transaction.amountBrl === 'number' ? transaction.amountBrl : null,
      transaction.type || null,
      transaction.provider || null,
      transaction.providerId || null,
      transaction.status || null,
      transaction.bankStatus || null,
      transaction.failureReason || null,
      createdAt,
      transaction.processedBy || null,
      transaction.invoiceId || null,
      transaction.invoiceStatus || null,
      transaction.invoicePath || null,
      transaction.invoiceHash || null,
      Boolean(transaction.invoiceHandled),
      Boolean(transaction.archived),
    ],
  );
};

const persistInvoiceToDb = async (pool, invoice) => {
  if (!pool) {
    return;
  }
  const createdAt =
    invoice.createdAt && !Number.isNaN(new Date(invoice.createdAt).getTime())
      ? invoice.createdAt
      : new Date().toISOString();
  await pool.query(
    `
      insert into invoices (
        id,
        user_id,
        provider,
        provider_id,
        path,
        hash,
        created_at
      )
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (id) do update set
        user_id = excluded.user_id,
        provider = excluded.provider,
        provider_id = excluded.provider_id,
        path = excluded.path,
        hash = excluded.hash,
        created_at = excluded.created_at
    `,
    [
      invoice.id,
      invoice.userId || null,
      invoice.provider || null,
      invoice.providerId || null,
      invoice.path || null,
      invoice.hash || null,
      createdAt,
    ],
  );
};

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
    upgradeToPro = false,
    orderCreatedAt,
  },
  pool,
) => {
  if (!memoryStore.transactions) memoryStore.transactions = [];

  const existingTx = memoryStore.transactions.find(
    (t) => t.providerId === providerId && t.provider === provider,
  );
  if (existingTx) {
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
    invoiceHandled: false,
    archived: false,
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
    await persistTransactionToDb(pool, transaction);
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
        createdAt: orderCreatedAt || new Date().toISOString(),
        provider,
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
    const invoiceRecord = {
      id: invoiceData.id,
      userId,
      provider,
      providerId,
      path: invoiceData.path,
      hash: invoiceData.hash,
      createdAt: invoiceData.createdAt,
    };
    memoryStore.invoices.push(invoiceRecord);

    if (memoryStore.users && typeof memoryStore.users.get === 'function') {
      const user = memoryStore.users.get(userId);
      if (user) {
        const currentCredits =
          typeof user.credits === 'number' && Number.isFinite(user.credits)
            ? user.credits
            : 0;
        user.credits = currentCredits + credits;
        if (upgradeToPro) {
          user.isPro = true;
        }
        memoryStore.users.set(userId, user);
        if (upgradeToPro) {
          console.log(
            `[PRO] User ${userId} upgraded to PRO via ${provider} payment.`,
          );
        }
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

    await persistInvoiceToDb(pool, {
      id: invoiceData.id,
      userId,
      provider,
      providerId,
      path: invoiceData.path,
      hash: invoiceData.hash,
      createdAt: invoiceData.createdAt,
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
  await persistTransactionToDb(pool, transaction);

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

    const user =
      memoryStore.users && memoryStore.users instanceof Map
        ? memoryStore.users.get(userId)
        : null;

    const credits =
      user && typeof user.credits === 'number' && Number.isFinite(user.credits)
        ? user.credits
        : 0;
    const hasPlan = user && user.isPro === true;

    const transactions = memoryStore.transactions || [];
    const userCompletedTransactions = transactions.filter(
      (t) =>
        t.userId === userId &&
        (t.status === 'completed' || t.status === 'paid'),
    );

    const hasCompletedPayment = userCompletedTransactions.length > 0;

    let firstPaymentAt = null;
    if (hasCompletedPayment) {
      const sorted = userCompletedTransactions
        .map((t) => new Date(t.createdAt))
        .filter((d) => !Number.isNaN(d.getTime()))
        .sort((a, b) => a - b);
      if (sorted.length > 0) {
        firstPaymentAt = sorted[0].toISOString();
      }
    }

    const locks = memoryStore.payment_locks || {};
    const lock = locks[userId];

    const shouldBlockForPendingPayment =
      lock &&
      lock.status === 'pending' &&
      !hasCompletedPayment &&
      !hasPlan &&
      credits <= 0;

    if (shouldBlockForPendingPayment) {
      return res.json({
        success: true,
        data: {
          accessAllowed: false,
          reason: 'pending_payment_first_time',
          lock,
          firstPaymentAt,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        accessAllowed: true,
        reason: null,
        lock: null,
        firstPaymentAt,
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

router.get('/transactions', async (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const pool = req.app.locals.pool;
    const { archived } = req.query;
    const archivedFlag = archived === 'true';

    if (pool) {
      const result = await pool.query(
        `
          select
            id,
            user_id as "userId",
            amount,
            amount_brl as "amountBrl",
            type,
            provider,
            provider_id as "providerId",
            status,
            bank_status as "bankStatus",
            failure_reason as "failureReason",
            created_at as "createdAt",
            processed_by as "processedBy",
            invoice_id as "invoiceId",
            invoice_status as "invoiceStatus",
            invoice_path as "invoicePath",
            invoice_hash as "invoiceHash",
            invoice_handled as "invoiceHandled",
            archived
          from payment_transactions
          where archived = $1
          order by created_at desc
          limit 100
        `,
        [archivedFlag],
      );
      return res.json({ success: true, data: result.rows });
    }

    let transactions = memoryStore.transactions || [];

    if (archived === 'true') {
      transactions = transactions.filter((t) => t.archived);
    } else {
      transactions = transactions.filter((t) => !t.archived);
    }

    transactions = transactions
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 100);

    res.json({ success: true, data: transactions });
  } catch (error) {
    console.error('[Admin] Get Transactions Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

router.patch('/transactions/:transactionId/invoice-handled', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { handled, adminId } = req.body || {};
    const memoryStore = req.app.locals.memoryStore;
    const pool = req.app.locals.pool;

    if (!transactionId) {
      return res
        .status(400)
        .json({ success: false, error: 'transactionId is required' });
    }

    let tx = (memoryStore.transactions || []).find(
      (t) => t.id === transactionId,
    );

    if (!tx && pool) {
      const result = await pool.query(
        `
          select
            id,
            user_id as "userId",
            amount,
            amount_brl as "amountBrl",
            type,
            provider,
            provider_id as "providerId",
            status,
            bank_status as "bankStatus",
            failure_reason as "failureReason",
            created_at as "createdAt",
            processed_by as "processedBy",
            invoice_id as "invoiceId",
            invoice_status as "invoiceStatus",
            invoice_path as "invoicePath",
            invoice_hash as "invoiceHash",
            invoice_handled as "invoiceHandled",
            archived
          from payment_transactions
          where id = $1
        `,
        [transactionId],
      );
      if (result.rows.length > 0) {
        tx = result.rows[0];
        if (!Array.isArray(memoryStore.transactions)) {
          memoryStore.transactions = [];
        }
        memoryStore.transactions.push(tx);
      }
    }

    if (!tx) {
      return res
        .status(404)
        .json({ success: false, error: 'Transaction not found' });
    }

    tx.invoiceHandled = Boolean(handled);

    logPaymentAudit(memoryStore, {
      provider: tx.provider || 'pix',
      type: 'admin_action',
      phase: 'invoice_handled',
      userId: tx.userId || null,
      orderId: tx.providerId || null,
      transactionId: tx.id,
      payload: { handled: Boolean(handled), adminId: adminId || null },
      status: 'updated',
    });

    if (memoryStore.save) memoryStore.save();
    await persistTransactionToDb(pool, tx);

    return res.json({ success: true, data: tx });
  } catch (error) {
    console.error('[Admin] Update Transaction InvoiceHandled Error:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Internal Server Error' });
  }
});

router.patch('/transactions/:transactionId/archive', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { adminId } = req.body || {};
    const memoryStore = req.app.locals.memoryStore;
    const pool = req.app.locals.pool;

    if (!transactionId) {
      return res
        .status(400)
        .json({ success: false, error: 'transactionId is required' });
    }

    let tx = (memoryStore.transactions || []).find(
      (t) => t.id === transactionId,
    );

    if (!tx && pool) {
      const result = await pool.query(
        `
          select
            id,
            user_id as "userId",
            amount,
            amount_brl as "amountBrl",
            type,
            provider,
            provider_id as "providerId",
            status,
            bank_status as "bankStatus",
            failure_reason as "failureReason",
            created_at as "createdAt",
            processed_by as "processedBy",
            invoice_id as "invoiceId",
            invoice_status as "invoiceStatus",
            invoice_path as "invoicePath",
            invoice_hash as "invoiceHash",
            invoice_handled as "invoiceHandled",
            archived
          from payment_transactions
          where id = $1
        `,
        [transactionId],
      );
      if (result.rows.length > 0) {
        tx = result.rows[0];
        if (!Array.isArray(memoryStore.transactions)) {
          memoryStore.transactions = [];
        }
        memoryStore.transactions.push(tx);
      }
    }

    if (!tx) {
      return res
        .status(404)
        .json({ success: false, error: 'Transaction not found' });
    }

    tx.archived = true;

    logPaymentAudit(memoryStore, {
      provider: tx.provider || 'pix',
      type: 'admin_action',
      phase: 'archive_transaction',
      userId: tx.userId || null,
      orderId: tx.providerId || null,
      transactionId: tx.id,
      payload: { archived: true, adminId: adminId || null },
      status: 'updated',
    });

    if (memoryStore.save) memoryStore.save();
    await persistTransactionToDb(pool, tx);

    return res.json({ success: true, data: tx });
  } catch (error) {
    console.error('[Admin] Archive Transaction Error:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Internal Server Error' });
  }
});

router.get('/transactions/export', async (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const pool = req.app.locals.pool;
    const { from, to, includeArchived } = req.query;

    let transactions = [];

    if (pool) {
      const rowsResult = await pool.query(
        `
          select
            id,
            user_id as "userId",
            amount,
            amount_brl as "amountBrl",
            type,
            provider,
            provider_id as "providerId",
            status,
            bank_status as "bankStatus",
            failure_reason as "failureReason",
            created_at as "createdAt",
            processed_by as "processedBy",
            invoice_id as "invoiceId",
            invoice_status as "invoiceStatus",
            invoice_path as "invoicePath",
            invoice_hash as "invoiceHash",
            invoice_handled as "invoiceHandled",
            archived
          from payment_transactions
        `,
      );
      transactions = rowsResult.rows;
    } else {
      transactions = memoryStore.transactions || [];
    }

    if (includeArchived !== 'true') {
      transactions = transactions.filter((t) => !t.archived);
    }

    let fromDate = null;
    let toDate = null;

    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) {
        fromDate = d;
      }
    }

    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) {
        toDate = d;
      }
    }

    transactions = transactions.filter((t) => {
      const created = new Date(t.createdAt || t.timestamp || 0);
      if (Number.isNaN(created.getTime())) return false;
      if (fromDate && created < fromDate) return false;
      if (toDate && created > toDate) return false;
      return true;
    });

    transactions.sort(
      (a, b) =>
        new Date(a.createdAt || a.timestamp || 0) -
        new Date(b.createdAt || b.timestamp || 0),
    );

    const header = [
      'data',
      'userId',
      'amountBrl',
      'credits',
      'provider',
      'providerId',
      'invoiceId',
      'invoiceStatus',
      'invoiceHandled',
      'archived',
    ];

    const lines = [header.join(';')];

    for (const tx of transactions) {
      const row = [
        tx.createdAt || '',
        tx.userId || '',
        tx.amountBrl ?? '',
        tx.amount ?? '',
        tx.provider || '',
        tx.providerId || '',
        tx.invoiceId || '',
        tx.invoiceStatus || '',
        tx.invoiceHandled ? 'true' : 'false',
        tx.archived ? 'true' : 'false',
      ].map((value) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number') return String(value);
        const str = String(value).replace(/"/g, '""');
        return `"${str}"`;
      });

      lines.push(row.join(';'));
    }

    const csv = lines.join('\n');
    const fileName = `nf_export_${from || 'inicio'}_${to || 'fim'}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`,
    );

    return res.send(csv);
  } catch (error) {
    console.error('[Admin] Export Transactions CSV Error:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Internal Server Error' });
  }
});

// --- PIX ENDPOINTS ---

// POST /api/payments/pix/order
router.post('/pix/order', (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const {
      userId,
      creditsPackage,
      amountBrl,
      cpfCnpj,
      upgradeToPro = false,
    } = req.body;

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
      createdAt: new Date().toISOString(),
      upgradeToPro: Boolean(upgradeToPro),
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
      upgradeToPro: Boolean(upgradeToPro),
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
    const pool = req.app.locals.pool;
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
      upgradeToPro: Boolean(order.upgradeToPro),
      orderCreatedAt: order.createdAt,
    }, pool);

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
    const { userId, creditsPackage, amountBrl, upgradeToPro = false } = req.body;

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
        amountBrl,
        upgradeToPro: upgradeToPro ? 'true' : 'false',
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
        const upgradeToPro =
          session.metadata?.upgradeToPro === 'true';

        if (userId) {
             const pool = req.app.locals.pool;
             await processPaymentConfirmation(memoryStore, {
                userId,
                amountBrl,
                credits: credits > 0 ? credits : 1,
                provider: 'stripe',
                providerId: session.id,
                cpfCnpj,
                bankStatus: 'CONFIRMED',
                bankResponse: { rawEventType: event.type },
                upgradeToPro,
                orderCreatedAt: session.created
                  ? new Date(session.created * 1000).toISOString()
                  : new Date().toISOString(),
            }, pool);
        } else {
            console.warn('[Stripe] Missing userId in session');
        }
    }

    res.json({received: true});
});

// --- INVOICE DOWNLOAD ---

// GET /api/payments/invoices/:invoiceId/download
router.get('/invoices/:invoiceId/download', verifyToken, async (req, res) => {
  try {
    const memoryStore = req.app.locals.memoryStore;
    const pool = req.app.locals.pool;
    const { invoiceId } = req.params;

    if (!invoiceId) {
      return res
        .status(400)
        .json({ success: false, error: 'Invoice ID is required' });
    }

    let invoiceRecord = (memoryStore.invoices || []).find(
      (inv) => inv.id === invoiceId,
    );

    if (!invoiceRecord && pool) {
      const result = await pool.query(
        `
          select
            id,
            user_id as "userId",
            provider,
            provider_id as "providerId",
            path,
            hash,
            created_at as "createdAt"
          from invoices
          where id = $1
        `,
        [invoiceId],
      );
      if (result.rows.length > 0) {
        invoiceRecord = result.rows[0];
        if (!Array.isArray(memoryStore.invoices)) {
          memoryStore.invoices = [];
        }
        memoryStore.invoices.push(invoiceRecord);
      }
    }

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
router.get('/invoices/:invoiceId/public', async (req, res) => {
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
    const pool = req.app.locals.pool;

    let invoiceRecord = (memoryStore.invoices || []).find(
      (inv) => inv.id === invoiceId,
    );

    if (!invoiceRecord && pool) {
      const result = await pool.query(
        `
          select
            id,
            user_id as "userId",
            provider,
            provider_id as "providerId",
            path,
            hash,
            created_at as "createdAt"
          from invoices
          where id = $1
        `,
        [invoiceId],
      );
      if (result.rows.length > 0) {
        invoiceRecord = result.rows[0];
        if (!Array.isArray(memoryStore.invoices)) {
          memoryStore.invoices = [];
        }
        memoryStore.invoices.push(invoiceRecord);
      }
    }

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
