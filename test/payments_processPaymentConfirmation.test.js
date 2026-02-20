import test from 'node:test';
import assert from 'node:assert/strict';
import { processPaymentConfirmation } from '../src/routes/payments.js';

const createMemoryStore = () => {
  const users = new Map();
  const userId = 'user-1';
  users.set(userId, { id: userId, name: 'Test User', credits: 0 });

  const store = {
    users,
    transactions: [],
    payment_audit_logs: [],
    invoices: [],
    save() {},
  };

  return { store, userId };
};

test('processPaymentConfirmation credits user and emits invoice on confirmed PIX', async () => {
  const { store, userId } = createMemoryStore();

  const result = await processPaymentConfirmation(store, {
    userId,
    amountBrl: 27,
    credits: 3,
    provider: 'pix',
    providerId: 'order-123',
    cpfCnpj: '12345678900',
    adminId: 'admin-1',
    bankStatus: 'CONFIRMED',
  });

  assert.ok(result.transaction);
  assert.equal(result.transaction.status, 'completed');
  assert.equal(result.transaction.invoiceStatus, 'emitted');
  assert.equal(store.users.get(userId).credits, 3);
});

test('processPaymentConfirmation does not credit user when bankStatus is TIMEOUT', async () => {
  const { store, userId } = createMemoryStore();

  const result = await processPaymentConfirmation(store, {
    userId,
    amountBrl: 27,
    credits: 3,
    provider: 'pix',
    providerId: 'order-456',
    cpfCnpj: '12345678900',
    adminId: 'admin-1',
    bankStatus: 'TIMEOUT',
    failureReason: 'Gateway timeout',
  });

  assert.ok(result.transaction);
  assert.equal(result.transaction.status, 'failed');
  assert.equal(store.users.get(userId).credits, 0);
});

