import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import generateMusicRouter from './routes/generateMusic.js';
import exportKitRouter from './routes/exportKit.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const metricsPath = path.resolve(__dirname, '../scripts/lyrics_feedback.json');
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    })
  : null;

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

app.use(cors());
app.use(express.json());

app.use('/api', generateMusicRouter);
app.use('/api', exportKitRouter);

app.get('/api/health', async (req, res) => {
  const db = await checkDatabase();

  if (!db.ok) {
    return res.status(503).json({ ok: false, db });
  }

  return res.json({ ok: true, db });
});

app.get('/api/admin/metrics', (req, res) => {
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
