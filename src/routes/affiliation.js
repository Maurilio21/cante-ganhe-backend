import express from 'express';
const router = express.Router();

// POST /api/affiliation/accept
router.post('/accept', (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  if (!memoryStore) {
    return res.status(500).json({ success: false, error: 'Store not initialized' });
  }

  const { userId, termsVersion } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, error: 'UserId is required' });
  }

  // Initialize affiliation_logs if not exists
  if (!memoryStore.affiliation_logs) {
    memoryStore.affiliation_logs = [];
  }

  const logEntry = {
    id: Date.now().toString(),
    userId,
    action: 'TERMS_ACCEPTED',
    termsVersion: termsVersion || 'v1',
    timestamp: new Date().toISOString(),
    ip: req.ip,
    userAgent: req.get('User-Agent')
  };

  memoryStore.affiliation_logs.push(logEntry);
  
  console.log(`[Affiliation] User ${userId} accepted terms.`);

  res.json({ success: true, data: logEntry });
});

// GET /api/affiliation/logs (Admin only)
router.get('/logs', (req, res) => {
    const memoryStore = req.app.locals.memoryStore;
    if (!memoryStore || !memoryStore.affiliation_logs) {
        return res.json({ success: true, data: [] });
    }
    res.json({ success: true, data: memoryStore.affiliation_logs });
});

export default router;
