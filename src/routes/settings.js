import express from 'express';

const router = express.Router();

// Get settings by key
router.get('/settings/:key', (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  const { key } = req.params;

  if (!memoryStore || !memoryStore.settings) {
    return res.status(500).json({ success: false, error: 'Store not initialized' });
  }

  const setting = memoryStore.settings.get(key);
  
  // Return default structure if not found to avoid frontend errors
  if (!setting && key === 'affiliation') {
     return res.json({ 
         success: true, 
         data: {
             enabled: false,
             terms: '',
             validity: null
         } 
     });
  }

  if (!setting && key === 'push_notifications') {
     return res.json({ 
         success: true, 
         data: {
             enabled: false
         } 
     });
  }

  res.json({ success: true, data: setting });
});

// Update settings
router.post('/settings/:key', (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  const { key } = req.params;
  const data = req.body;

  if (!memoryStore || !memoryStore.settings) {
    return res.status(500).json({ success: false, error: 'Store not initialized' });
  }

  memoryStore.settings.set(key, data);
  if (memoryStore.save) memoryStore.save();

  res.json({ success: true, data });
});

export default router;
