import express from 'express';
import { verifyToken, requireAdminOrMaster } from './users.js';

const router = express.Router();

router.get('/communities', (req, res) => {
  const memoryStore = req.app.locals.memoryStore;

  if (!memoryStore || !memoryStore.settings) {
    console.error('[Communities] GET /communities failed: Store not initialized');
    return res.status(500).json({ success: false, error: 'Store not initialized' });
  }

  const stored = memoryStore.settings.get('communities') || {
    whatsapp: { link: '', active: false },
    telegram: { link: '', active: false },
    helpWhatsapp: { phone: '', message: '' },
    musicPacks: [],
    ignorePacksGuarantee: false
  };

  const settings = {
    ...stored,
    musicPacks: Array.isArray(stored.musicPacks) ? stored.musicPacks : [],
    ignorePacksGuarantee:
      typeof stored.ignorePacksGuarantee === 'boolean'
        ? stored.ignorePacksGuarantee
        : false
  };

  console.log('[Communities] GET /communities ->', {
    whatsappActive: settings.whatsapp?.active,
    telegramActive: settings.telegram?.active,
    whatsappLink: settings.whatsapp?.link,
    telegramLink: settings.telegram?.link
  });

  res.json({ success: true, data: settings });
});

router.put('/communities', verifyToken, requireAdminOrMaster, (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  const {
    whatsapp,
    telegram,
    helpWhatsapp,
    musicPacks,
    ignorePacksGuarantee,
  } = req.body;

  if (!memoryStore || !memoryStore.settings) {
    console.error('[Communities] PUT /communities failed: Store not initialized');
    return res.status(500).json({ success: false, error: 'Store not initialized' });
  }

  const previousSettings = memoryStore.settings.get('communities') || {};

  console.log('[Communities] PUT /communities payload:', {
    whatsapp,
    telegram,
    helpWhatsapp,
    musicPacks
  });

  const isValidUrl = (url) => {
    if (!url) return true; // Empty is valid (clearing the link)
    try {
      new URL(url);
      return true;
    } catch (e) {
      return false;
    }
  };

  const isValidDriveUrl = (url) => {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.host.toLowerCase();
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        host.includes('drive.google.com')
      );
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

  const normalizePhone = (phone) => {
    if (!phone) return '';
    return String(phone).replace(/[^\d]/g, '');
  };

  const sanitizeText = (value) => {
    if (!value) return '';
    return String(value).replace(/[<>]/g, '').trim();
  };

  const helpPhone = normalizePhone(helpWhatsapp?.phone);

  if (helpPhone && helpPhone.length < 10) {
    return res.status(400).json({
      success: false,
      error: 'Número de WhatsApp de ajuda inválido'
    });
  }

  let newWhatsappActive = whatsapp?.active || false;
  let newTelegramActive = telegram?.active || false;

  if (newWhatsappActive && newTelegramActive) {
    console.warn('[Communities] PUT /communities rejected: both WhatsApp and Telegram marked active');
    return res.status(400).json({ success: false, error: 'Apenas uma comunidade pode estar ativa por vez.' });
  }

  if (Array.isArray(musicPacks)) {
    for (const pack of musicPacks) {
      if (!pack || typeof pack !== 'object') continue;
      const link = String(pack.link || '').trim();
      if (!link) {
        return res.status(400).json({
          success: false,
          error: 'Link do pack de músicas é obrigatório'
        });
      }
      if (!isValidDriveUrl(link)) {
        return res.status(400).json({
          success: false,
          error:
            'Link do pack de músicas inválido. Use um link público do Google Drive.'
        });
      }

      const availableForBasic =
        pack.availableForBasic === undefined ||
        pack.availableForBasic === null
          ? true
          : Boolean(pack.availableForBasic);
      const availableForPro =
        pack.availableForPro === undefined || pack.availableForPro === null
          ? true
          : Boolean(pack.availableForPro);

      if (!availableForBasic && !availableForPro) {
        return res.status(400).json({
          success: false,
          error:
            'Selecione ao menos um plano (básico ou profissional) para cada pack de músicas.'
        });
      }
    }
  }

  const previousPacks = Array.isArray(previousSettings.musicPacks)
    ? previousSettings.musicPacks
    : [];

  console.log(
    '[Communities] PUT /communities incoming musicPacks (id, ignoreGuarantee):',
    Array.isArray(musicPacks)
      ? musicPacks.map((p) => ({
          id: p && p.id,
          ignoreGuarantee: p && p.ignoreGuarantee
        }))
      : musicPacks
  );

  const safePacks = Array.isArray(musicPacks)
    ? musicPacks
        .filter((pack) => pack && typeof pack === 'object')
        .map((pack, index) => {
          const rawId =
            pack.id ||
            (previousPacks[index] && previousPacks[index].id) ||
            `${Date.now()}-${index}`;
          const id = String(rawId);
          const previous = previousPacks.find((p) => p.id === id) || {};
          const link = String(pack.link || '').trim();
          const availableForBasic =
            pack.availableForBasic === undefined ||
            pack.availableForBasic === null
              ? true
              : Boolean(pack.availableForBasic);
          const availableForPro =
            pack.availableForPro === undefined ||
            pack.availableForPro === null
              ? true
              : Boolean(pack.availableForPro);
          const ignoreGuarantee =
            pack.ignoreGuarantee === undefined ||
            pack.ignoreGuarantee === null
              ? false
              : Boolean(pack.ignoreGuarantee);

          return {
            id,
            title: sanitizeText(pack.title || ''),
            link,
            description: sanitizeText(pack.description || ''),
            active: Boolean(pack.active),
            availableForBasic,
            availableForPro,
            ignoreGuarantee,
            createdAt: previous.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
        })
    : [];

  console.log(
    '[Communities] PUT /communities normalized musicPacks (id, ignoreGuarantee):',
    safePacks.map((p) => ({
      id: p.id,
      ignoreGuarantee: p.ignoreGuarantee
    }))
  );

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
    musicPacks: safePacks,
    ignorePacksGuarantee:
      typeof ignorePacksGuarantee === 'boolean'
        ? ignorePacksGuarantee
        : Boolean(previousSettings.ignorePacksGuarantee),
    updatedAt: new Date().toISOString()
  };

  memoryStore.settings.set('communities', newSettings);

  if (!memoryStore.audit_logs) {
    memoryStore.audit_logs = [];
  }

  const auditLog = {
    id: Date.now().toString(),
    action: 'COMMUNITY_SETTINGS_UPDATED',
    timestamp: new Date().toISOString(),
    adminId: req.userId,
    details: {
      whatsappActiveBefore: previousSettings.whatsapp?.active ?? false,
      telegramActiveBefore: previousSettings.telegram?.active ?? false,
      whatsappActiveAfter: newSettings.whatsapp.active,
      telegramActiveAfter: newSettings.telegram.active,
      musicPacksBefore: Array.isArray(previousPacks)
        ? previousPacks.map((p) => ({
            id: p.id,
            title: p.title,
            active: p.active,
            availableForBasic:
              p.availableForBasic === undefined ||
              p.availableForBasic === null
                ? true
                : Boolean(p.availableForBasic),
            availableForPro:
              p.availableForPro === undefined || p.availableForPro === null
                ? true
                : Boolean(p.availableForPro)
          }))
        : [],
      musicPacksAfter: newSettings.musicPacks.map((p) => ({
        id: p.id,
        title: p.title,
        active: p.active,
        availableForBasic: p.availableForBasic,
        availableForPro: p.availableForPro,
        ignoreGuarantee: p.ignoreGuarantee
      })),
      ignorePacksGuaranteeBefore:
        typeof previousSettings.ignorePacksGuarantee === 'boolean'
          ? previousSettings.ignorePacksGuarantee
          : false,
      ignorePacksGuaranteeAfter: newSettings.ignorePacksGuarantee
    }
  };

  memoryStore.audit_logs.push(auditLog);

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
