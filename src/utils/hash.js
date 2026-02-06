import crypto from 'crypto';

export function createHash(data) {
  const content = JSON.stringify(data);
  return crypto.createHash('sha256').update(content).digest('hex');
}
