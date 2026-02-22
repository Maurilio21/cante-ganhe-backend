import express from 'express';
import { verifyToken, requireAdminOrMaster } from './users.js';

const router = express.Router();

// Get community settings
router.get('/communities', (req, res) => {
  const memoryStore = req.app.locals.memoryStore;

  if (!memoryStore || !memoryStore.settings) {
    console.error('[Communities] GET /communities failed: Store not initialized');
    return res.status(500).json({ success: false, error: 'Store not initialized' });
  }

  const settings = memoryStore.settings.get('communities') || {
    whatsapp: { link: '', active: false },
    telegram: { link: '', active: false },
    helpWhatsapp: { phone: '', message: '' }
  };

  console.log('[Communities] GET /communities ->', {
    whatsappActive: settings.whatsapp?.active,
    telegramActive: settings.telegram?.active,
    whatsappLink: settings.whatsapp?.link,
    telegramLink: settings.telegram?.link
  });

  res.json({ success: true, data: settings });
});

// Update community settings
router.put('/communities', verifyToken, requireAdminOrMaster, (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  const { whatsapp, telegram, helpWhatsapp } = req.body;

  if (!memoryStore || !memoryStore.settings) {
    console.error('[Communities] PUT /communities failed: Store not initialized');
    return res.status(500).json({ success: false, error: 'Store not initialized' });
  }

  console.log('[Communities] PUT /communities payload:', {
    whatsapp,
    telegram,
    helpWhatsapp
  });

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

  // 2. Validate help whatsapp phone if provided
  const normalizePhone = (phone) => {
    if (!phone) return '';
    return String(phone).replace(/[^\d]/g, '');
  };

  const helpPhone = normalizePhone(helpWhatsapp?.phone);

  if (helpPhone && helpPhone.length < 10) {
    return res.status(400).json({
      success: false,
      error: 'Número de WhatsApp de ajuda inválido'
    });
  }

  // 3. Exclusivity Logic: Only one can be active
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
    console.warn('[Communities] PUT /communities rejected: both WhatsApp and Telegram marked active');
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
    helpWhatsapp: {
      phone: helpPhone,
      message: helpWhatsapp?.message || '',
      updatedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  };

  memoryStore.settings.set('communities', newSettings);
  if (memoryStore.save) memoryStore.save();

  console.log('[Communities] Updated settings:', {
    whatsappActive: newSettings.whatsapp.active,
    telegramActive: newSettings.telegram.active,
    whatsappLink: newSettings.whatsapp.link,
    telegramLink: newSettings.telegram.link,
    helpWhatsappPhone: newSettings.helpWhatsapp.phone
  });

  res.json({ success: true, data: newSettings });
});

export default router;
