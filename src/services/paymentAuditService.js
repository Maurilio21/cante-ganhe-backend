import { v4 as uuidv4 } from 'uuid';

export const logPaymentAudit = (memoryStore, entry) => {
  if (!memoryStore) return;

  if (!memoryStore.payment_audit_logs) {
    memoryStore.payment_audit_logs = [];
  }

  const logEntry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    provider: entry.provider || 'pix',
    type: entry.type || 'unknown',
    phase: entry.phase || 'unspecified',
    userId: entry.userId || null,
    orderId: entry.orderId || null,
    transactionId: entry.transactionId || null,
    payload: entry.payload || null,
    bankStatus: entry.bankStatus || null,
    bankResponse: entry.bankResponse || null,
    status: entry.status || null,
    errorCode: entry.errorCode || null,
    errorMessage: entry.errorMessage || null,
  };

  memoryStore.payment_audit_logs.push(logEntry);
  if (typeof memoryStore.save === 'function') {
    memoryStore.save();
  }

  return logEntry;
};

