import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import generateMusicRouter from './routes/generateMusic.js';
import exportKitRouter from './routes/exportKit.js';
import settingsRouter from './routes/settings.js';
import affiliationRouter from './routes/affiliation.js';
import paymentRouter from './routes/payments.js';
import usersRouter, {
  verifyToken as authVerifyToken,
  requireAdminOrMaster as authRequireAdminOrMaster,
} from './routes/users.js';
import communitiesRouter from './routes/communities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const { Pool } = pg;
const metricsPath = path.resolve(__dirname, '../scripts/lyrics_feedback.json');
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    })
  : null;

app.locals.pool = pool;

// File-based persistence for development (when DB is unavailable)
const DB_FILE = path.resolve(__dirname, 'dev_db.json');
const DB_BACKUP_FILE = path.resolve(__dirname, 'dev_db.backup.json');

const reconcileCredits = (store) => {
  try {
    const transactions = Array.isArray(store.transactions)
      ? [...store.transactions]
      : [];

    transactions.sort((a, b) => {
      const aDate = new Date(a.createdAt || a.timestamp || 0).getTime();
      const bDate = new Date(b.createdAt || b.timestamp || 0).getTime();
      return aDate - bDate;
    });

    const creditsByUser = new Map();

    for (const tx of transactions) {
      if (!tx || !tx.userId || typeof tx.type !== 'string') {
        continue;
      }

      const userId = tx.userId;
      let current = creditsByUser.has(userId) ? creditsByUser.get(userId) : 0;
      const type = tx.type;

      if (type === 'reset_credits') {
        current = 0;
      } else if (
        type === 'grant' ||
        type === 'manual_grant' ||
        type === 'manual_grant_bulk' ||
        type === 'manual_revoke' ||
        type === 'usage'
      ) {
        const amount =
          typeof tx.amount === 'number' && Number.isFinite(tx.amount)
            ? tx.amount
            : 0;
        current += amount;
      } else {
        continue;
      }

      if (!Number.isFinite(current) || current < 0) {
        current = 0;
      }

      creditsByUser.set(userId, current);
    }

    if (!(store.users instanceof Map)) {
      return;
    }

    for (const [id, user] of store.users.entries()) {
      const stored =
        typeof user.credits === 'number' && Number.isFinite(user.credits)
          ? user.credits
          : 0;
      const expected = creditsByUser.has(id) ? creditsByUser.get(id) : stored;

      if (!('credits' in user)) {
        user.credits = expected;
        store.users.set(id, user);
        continue;
      }

      if (expected !== stored) {
        console.log(
          `[Credits][RECONCILE] User ${id}: correcting credits from ${stored} to ${expected}`,
        );
        user.credits = expected;
        store.users.set(id, user);
      }
    }
  } catch (error) {
    console.error('[Credits][RECONCILE] Error while reconciling credits:', error);
  }
};

const loadMemoryStore = () => {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const json = JSON.parse(data);
      const store = {
        stem_tasks: new Map(json.stem_tasks),
        user_tracks: new Map(json.user_tracks),
        tasks: new Map(json.tasks || []), // Fallback for other tasks if needed
        settings: new Map(json.settings || []),
        affiliation_logs: json.affiliation_logs || [],
        pix_payments: json.pix_payments || [],
        transactions: json.transactions || [],
        users: new Map(json.users || []),
        audit_logs: json.audit_logs || [],
        payment_audit_logs: json.payment_audit_logs || [],
        invoices: json.invoices || [],
      };
      reconcileCredits(store);
      return store;
    }

    if (fs.existsSync(DB_BACKUP_FILE)) {
      const backupData = fs.readFileSync(DB_BACKUP_FILE, 'utf8');
      const backupJson = JSON.parse(backupData);
      const backupStore = {
        stem_tasks: new Map(backupJson.stem_tasks),
        user_tracks: new Map(backupJson.user_tracks),
        tasks: new Map(backupJson.tasks || []),
        settings: new Map(backupJson.settings || []),
        affiliation_logs: backupJson.affiliation_logs || [],
        pix_payments: backupJson.pix_payments || [],
        transactions: backupJson.transactions || [],
        users: new Map(backupJson.users || []),
        audit_logs: backupJson.audit_logs || [],
        payment_audit_logs: backupJson.payment_audit_logs || [],
        invoices: backupJson.invoices || [],
      };
      reconcileCredits(backupStore);
      console.warn('Loaded memory store from backup file.');
      return backupStore;
    }
  } catch (error) {
    console.error("Error loading dev database:", error);
  }
    return {
      stem_tasks: new Map(),
      user_tracks: new Map(),
      tasks: new Map(),
      settings: new Map(),
      affiliation_logs: [],
      pix_payments: [],
      transactions: [],
      users: new Map(),
      audit_logs: [],
      payment_audit_logs: [],
      invoices: [],
    };
};

const saveMemoryStore = (store) => {
  try {
    if (fs.existsSync(DB_FILE)) {
      try {
        fs.copyFileSync(DB_FILE, DB_BACKUP_FILE);
      } catch (backupError) {
        console.error('Error creating dev database backup:', backupError);
      }
    }

    const data = {
      stem_tasks: Array.from(store.stem_tasks.entries()),
      user_tracks: Array.from(store.user_tracks.entries()),
      tasks: Array.from(store.tasks ? store.tasks.entries() : []),
      settings: Array.from(store.settings ? store.settings.entries() : []),
      affiliation_logs: store.affiliation_logs || [],
      pix_payments: store.pix_payments || [],
      transactions: store.transactions || [],
      users: Array.from(store.users ? store.users.entries() : []),
      audit_logs: store.audit_logs || [],
      payment_audit_logs: store.payment_audit_logs || [],
      invoices: store.invoices || [],
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    console.log("Dev database saved to disk.");
  } catch (error) {
    console.error("Error saving dev database:", error);
  }
};

// In-memory store fallback when database is not available
app.locals.memoryStore = loadMemoryStore();
// Attach save method
app.locals.memoryStore.save = () => saveMemoryStore(app.locals.memoryStore);


const ensureTracksTable = async () => {
  if (!pool) {
    return;
  }
  await pool.query(`
    create table if not exists user_tracks (
      user_id text not null,
      track_id text not null,
      source_task_id text,
      title text,
      style text,
      cover_color_hex text,
      image_url text,
      audio_url text,
      created_at timestamptz,
      lyrics text,
      duration text,
      prompt text,
      mode text,
      voice text,
      cifra text,
      music_xml text,
      updated_at timestamptz not null default now(),
      primary key (user_id, track_id)
    )
  `);
  await pool.query(
    `alter table user_tracks add column if not exists source_task_id text`,
  );
};

const ensureStemTasksTable = async () => {
  if (!pool) {
    return;
  }
  await pool.query(`
    create table if not exists stem_tasks (
      task_id text primary key,
      user_id text,
      track_id text,
      source_task_id text,
      audio_id text,
      mode text,
      status text,
      result jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
};

ensureTracksTable().catch(() => {});
ensureStemTasksTable().catch(() => {});

const checkDatabase = async () => {
  if (!pool) {
    return { ok: false, error: 'DATABASE_URL not set' };
  }

  try {
    await pool.query('select 1');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

const isProduction = process.env.NODE_ENV === 'production';
const allowedOriginsEnv = process.env.CORS_ALLOWED_ORIGINS || '';
const allowedOrigins = allowedOriginsEnv
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!isProduction || allowedOrigins.length === 0) {
        return callback(null, true);
      }
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
  }),
);
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (isProduction) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
  next();
});

// Logger Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use('/api', generateMusicRouter);
app.use('/api', exportKitRouter);
app.use('/api', settingsRouter);
app.use('/api/affiliation', affiliationRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/users', usersRouter);
app.use('/api', communitiesRouter);

app.get('/api/health', async (req, res) => {
  const db = await checkDatabase();

  // Se o banco não estiver configurado, retornamos 200 OK mas com aviso no corpo,
  // pois a geração de música via OpenAI não depende do banco.
  if (!db.ok) {
    return res.json({ ok: true, warning: 'Database not connected', db });
  }

  return res.json({ ok: true, db });
});

app.get('/api/admin/metrics', authVerifyToken, authRequireAdminOrMaster, (req, res) => {
  try {
    const raw = fs.readFileSync(metricsPath, 'utf-8');
    const data = JSON.parse(raw);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Falha ao ler métricas' });
  }
});

app.get('/', (req, res) => {
  res.send('Cante e Ganhe API Running');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;
