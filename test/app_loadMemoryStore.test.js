import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMemoryStore } from '../src/app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.resolve(__dirname, '../src/dev_db.json');
const DB_BACKUP_FILE = path.resolve(__dirname, '../src/dev_db.backup.json');

const writeJson = (filePath, json) => {
  fs.writeFileSync(filePath, JSON.stringify(json), 'utf8');
};

const removeFile = (filePath) => {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

test('loadMemoryStore uses backup file when primary is missing', async () => {
  removeFile(DB_FILE);
  writeJson(DB_BACKUP_FILE, {
    users: [['user-1', { id: 'user-1', credits: 5 }]],
    transactions: [],
    stem_tasks: [],
    user_tracks: [],
    tasks: [],
    settings: [],
    affiliation_logs: [],
    pix_payments: [],
    deleted_users: [],
    audit_logs: [],
    payment_audit_logs: [],
    invoices: [],
  });

  const store = loadMemoryStore();
  assert.equal(store.users.get('user-1').credits, 5);

  removeFile(DB_BACKUP_FILE);
});
