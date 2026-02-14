import express from 'express';

const router = express.Router();

// Get community settings
router.get('/communities', (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  
  if (!memoryStore || !memoryStore.settings) {
    return res.status(500).json({ success: false, error: 'Store not initialized' });
  }

  const settings = memoryStore.settings.get('communities') || {
    whatsapp: { link: '', active: false },
    telegram: { link: '', active: false }
  };

  res.json({ success: true, data: settings });
});

// Update community settings
router.put('/communities', (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  const { whatsapp, telegram } = req.body;

  if (!memoryStore || !memoryStore.settings) {
    return res.status(500).json({ success: false, error: 'Store not initialized' });
  }

  // Validation
  // 1. Validate URLs if provided
  const isValidUrl = (url) => {
    if (!url) return true; // Empty is valid (clearing the link)
    try {
      new URL(url);
      return true;
    } catch (e) {
      return false;
    }
  };

  if (!isValidUrl(whatsapp?.link)) {
    return res.status(400).json({ success: false, error: 'Link do WhatsApp inválido' });
  }
  if (!isValidUrl(telegram?.link)) {
    return res.status(400).json({ success: false, error: 'Link do Telegram inválido' });
  }

  // 2. Exclusivity Logic: Only one can be active
  // If both claim to be active, reject or prioritize one. 
  // The user requirement says: "Adicionar funcionalidade de ativação/desativação exclusiva"
  // "Quando um grupo está ativo, o outro deve ser automaticamente desativado/ocultado"
  // We will enforce this by ensuring only one is true in the saved state.
  
  let newWhatsappActive = whatsapp?.active || false;
  let newTelegramActive = telegram?.active || false;

  // If both are true, throw error or fix it. The requirement says "notificação visual quando o usuário tentar ativar ambos",
  // which implies frontend validation, but backend should also enforce.
  // We will strictly enforce: if the request tries to activate both, we fail.
  if (newWhatsappActive && newTelegramActive) {
    return res.status(400).json({ success: false, error: 'Apenas uma comunidade pode estar ativa por vez.' });
  }

  const newSettings = {
    whatsapp: {
      link: whatsapp?.link || '',
      active: newWhatsappActive,
      updatedAt: new Date().toISOString()
    },
    telegram: {
      link: telegram?.link || '',
      active: newTelegramActive,
      updatedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  };

  memoryStore.settings.set('communities', newSettings);
  if (memoryStore.save) memoryStore.save();

  res.json({ success: true, data: newSettings });
});

export default router;
