import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
export const SECRET_KEY = process.env.JWT_SECRET || 'secret_key_dev';

const unauthorizedAttempts = new Map();
const UNAUTHORIZED_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const UNAUTHORIZED_THRESHOLD = 5;

const registerUnauthorizedAttempt = (req, reason) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
  const key = String(ip);
  const now = Date.now();

  const existing = unauthorizedAttempts.get(key) || [];
  const recent = existing.filter((ts) => now - ts < UNAUTHORIZED_WINDOW_MS);
  recent.push(now);
  unauthorizedAttempts.set(key, recent);

  const payload = {
    ip,
    timestamp: new Date(now).toISOString(),
    path: req.originalUrl || req.url,
    method: req.method,
    userId: req.userId || null,
    reason,
  };

  console.warn('[SECURITY] Unauthorized access attempt:', payload);

  if (recent.length >= UNAUTHORIZED_THRESHOLD) {
    console.error('[SECURITY ALERT] Multiple unauthorized attempts detected from IP:', ip, {
      attemptsLast10m: recent.length,
      lastPath: payload.path,
    });
  }
};

// Middleware to verify JWT
export const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    registerUnauthorizedAttempt(req, 'NO_TOKEN');
    return res.status(403).json({ error: 'No token provided' });
  }

  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) {
      registerUnauthorizedAttempt(req, 'INVALID_TOKEN');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.userId = decoded.id;
    req.userRole = decoded.role;
    req.permissions = decoded.permissions || {};
    next();
  });
};

// Middleware to check permissions
export const checkPermission = (permission) => {
  return (req, res, next) => {
    if (req.userRole === 'master') return next();

    if (req.permissions && req.permissions[permission]) {
      return next();
    }
    registerUnauthorizedAttempt(req, `MISSING_PERMISSION:${permission}`);
    return res
      .status(403)
      .json({ error: 'Forbidden: Insufficient permissions' });
  };
};

export const requireAdminOrMaster = (req, res, next) => {
  if (req.userRole === 'master' || req.userRole === 'admin') {
    return next();
  }
  registerUnauthorizedAttempt(req, 'ROLE_NOT_ADMIN');
  return res
    .status(403)
    .json({ error: 'Forbidden: Admin or Master only endpoint' });
};

export const requirePaidAccess = (req, res, next) => {
  const memoryStore = req.app.locals.memoryStore;
  if (!memoryStore || !memoryStore.users) {
    registerUnauthorizedAttempt(req, 'STORE_NOT_INITIALIZED');
    return res.status(503).json({ error: 'Service unavailable' });
  }

  const user = memoryStore.users.get(req.userId);
  if (!user) {
    registerUnauthorizedAttempt(req, 'USER_NOT_FOUND');
    return res.status(401).json({ error: 'User not found' });
  }

  const credits =
    typeof user.credits === 'number' && Number.isFinite(user.credits)
      ? user.credits
      : 0;

  const hasPlan = user.isPro === true;

  const transactions = memoryStore.transactions || [];
  const hasCompletedPayment = transactions.some(
    (t) =>
      t.userId === user.id &&
      (t.status === 'completed' || t.status === 'paid'),
  );

  const locks = memoryStore.payment_locks || {};
  const lock = locks[user.id];
  const shouldBlockForPendingPayment =
    lock &&
    lock.status === 'pending' &&
    !hasCompletedPayment &&
    !hasPlan &&
    credits <= 0;

  if (shouldBlockForPendingPayment) {
    registerUnauthorizedAttempt(req, 'PENDING_PAYMENT_LOCK_FIRST_TIME');
    return res.status(403).json({
      error:
        'Acesso temporariamente bloqueado até a confirmação do seu primeiro pagamento.',
    });
  }

  if (!hasPlan && credits <= 0) {
    registerUnauthorizedAttempt(req, 'NO_PLAN_OR_CREDITS');
    return res.status(403).json({
      error: 'Plano ou créditos insuficientes para acessar esta funcionalidade.',
    });
  }

  next();
};

// Helper to log actions
const logAction = (req, action, targetUserId, details = {}) => {
  const memoryStore = req.app.locals.memoryStore;
  const log = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    adminId: req.userId,
    targetUserId,
    action,
    details
  };
  memoryStore.audit_logs.push(log);
  memoryStore.save();
};

// Helper to sync mock users (Optional, for dev continuity)
const syncMockUsers = (memoryStore) => {
    // Create Master
    const masterId = 'master';
    if (!memoryStore.users.has(masterId)) {
        const hashedPassword = bcrypt.hashSync('45Dyrs@45', 10);
        memoryStore.users.set(masterId, {
            id: masterId,
            name: 'Maurilio Sobral',
            email: 'maurilio@master.com', 
            phone: '(11) 99999-0000',
            password: hashedPassword,
            role: 'master',
            isPro: true,
            whatsappNotificationsEnabled: true,
            permissions: { canGrantPro: true, viewUsers: true, viewLogs: true, manageAdmins: true }
        });
    }
    // Create Basic User
    const userId = '1';
    if (!memoryStore.users.has(userId)) {
            const hashedPassword = bcrypt.hashSync('123', 10);
            memoryStore.users.set(userId, {
                id: userId,
                name: 'Maurílio',
                email: 'maurilio@example.com',
                phone: '(11) 99999-9999',
                password: hashedPassword,
                role: 'user',
                isPro: true,
                permissions: {}
            });
    }

    // Create Admin User (matching frontend mock)
    const adminId = '2';
    if (!memoryStore.users.has(adminId)) {
            const hashedPassword = bcrypt.hashSync('123', 10);
            memoryStore.users.set(adminId, {
                id: adminId,
                name: 'Admin',
                email: 'admin@canteeganhe.com',
                phone: '(11) 88888-8888',
                password: hashedPassword,
                role: 'admin',
                isPro: true,
                permissions: {}
            });
    }

    // Create Blocked User (matching frontend mock)
    const blockedId = '3';
    if (!memoryStore.users.has(blockedId)) {
            const hashedPassword = bcrypt.hashSync('123', 10);
            memoryStore.users.set(blockedId, {
                id: blockedId,
                name: 'Usuário Bloqueado',
                email: 'blocked@example.com',
                phone: '(11) 77777-7777',
                password: hashedPassword,
                role: 'user',
                status: 'blocked',
                isPro: false,
                permissions: {}
            });
    }

    memoryStore.save();
};

// Public Registration (no token required)
router.post('/register', async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      cpf,
      addressStreet,
      addressNumber,
      addressComplement,
      addressDistrict,
      addressCity,
      addressState,
    } = req.body;
    const memoryStore = req.app.locals.memoryStore;

    if (!memoryStore || !memoryStore.users) {
      return res.status(500).json({ error: 'Store not initialized' });
    }

    syncMockUsers(memoryStore);

    if (Array.from(memoryStore.users.values()).some((u) => u.email === email)) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password || '123456', 10);
    const newUser = {
      id: uuidv4(),
      name,
      email,
      phone,
      cpf: cpf || null,
      addressStreet: addressStreet || null,
      addressNumber: addressNumber || null,
      addressComplement: addressComplement || null,
      addressDistrict: addressDistrict || null,
      addressCity: addressCity || null,
      addressState: addressState || null,
      password: hashedPassword,
      role: 'user',
      isPro: false,
      permissions: {},
      createdAt: new Date().toISOString(),
      status: 'active',
      credits: 0,
    };

    memoryStore.users.set(newUser.id, newUser);
    memoryStore.save();

    const { password: _, ...userSafe } = newUser;
    return res.json(userSafe);
  } catch (error) {
    console.error('Public registration error:', error);
    return res
      .status(500)
      .json({ error: 'Failed to register user. Please try again later.' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const memoryStore = req.app.locals.memoryStore;

  // Sync mock users if empty
  syncMockUsers(memoryStore);

  // Find user
  let user = Array.from(memoryStore.users.values()).find((u) => u.email === email);

  if (!user) return res.status(404).json({ error: 'User not found' });

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) return res.status(401).json({ error: 'Invalid password' });

  if (user.status === 'blocked') {
    return res.status(403).json({
      error:
        'User is blocked. Please contact support to restore access.',
    });
  }

  const normalizedCredits =
    typeof user.credits === 'number' && Number.isFinite(user.credits)
      ? user.credits
      : 0;

  user.credits = normalizedCredits;
  memoryStore.users.set(user.id, user);
  memoryStore.save();

  const token = jwt.sign(
    {
      id: user.id,
      role: user.role,
      permissions: user.permissions,
    },
    SECRET_KEY,
    { expiresIn: '15m' },
  );

  const { password: _, ...userSafe } = user;
  res.json({ token, user: userSafe });
});

// List Users
router.get('/', verifyToken, checkPermission('viewUsers'), (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  syncMockUsers(memoryStore); // Ensure users exist
  const users = Array.from(memoryStore.users.values()).map(
    ({ password, ...u }) => u,
  );
  res.json(users);
});

// Get current authenticated user (for client sync)
router.get('/me', verifyToken, (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  const user = memoryStore.users.get(req.userId);

  if (!user) {
    return res
      .status(404)
      .json({ success: false, error: 'User not found for current token' });
  }

  const { password: _, ...userSafe } = user;
  res.json({ success: true, data: userSafe });
});

// Create User (Public/Authenticated) - For Admin Panel "Add User" or Registration
router.post('/', verifyToken, checkPermission('viewUsers'), (req, res) => {
    const {
      name,
      email,
      phone,
      password,
      cpf,
      addressStreet,
      addressNumber,
      addressComplement,
      addressDistrict,
      addressCity,
      addressState,
    } = req.body;
    const memoryStore = req.app.locals.memoryStore;

    if (Array.from(memoryStore.users.values()).some(u => u.email === email)) {
        return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = bcrypt.hashSync(password || '123456', 10); // Default password if added by admin without one
    const newUser = {
      id: uuidv4(),
      name,
      email,
      phone,
      cpf: cpf || null,
      addressStreet: addressStreet || null,
      addressNumber: addressNumber || null,
      addressComplement: addressComplement || null,
      addressDistrict: addressDistrict || null,
      addressCity: addressCity || null,
      addressState: addressState || null,
      password: hashedPassword,
      role: 'user',
      isPro: false,
      permissions: {},
      createdAt: new Date().toISOString(),
      credits: 0,
    };

    memoryStore.users.set(newUser.id, newUser);
    memoryStore.save();
    
    logAction(req, 'CREATE_USER', newUser.id);

    const { password: _, ...userSafe } = newUser;
    res.json(userSafe);
});

// Create Admin (Master only)
router.post('/admin', verifyToken, (req, res) => {
    if (req.userRole !== 'master') return res.status(403).json({ error: 'Only Master can create admins' });
    
    const { name, email, password, permissions } = req.body;
    const memoryStore = req.app.locals.memoryStore;

    if (Array.from(memoryStore.users.values()).some(u => u.email === email)) {
        return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const newUser = {
        id: uuidv4(),
        name,
        email,
        password: hashedPassword,
        role: 'admin',
        isPro: true, 
        permissions: permissions || { viewUsers: true },
        credits: 0,
    };

    memoryStore.users.set(newUser.id, newUser);
    memoryStore.save();
    
    logAction(req, 'CREATE_ADMIN', newUser.id, { permissions });

    const { password: _, ...userSafe } = newUser;
    res.json(userSafe);
});

// Update Admin Permissions (Master only)
router.put('/:id/permissions', verifyToken, (req, res) => {
    if (req.userRole !== 'master') return res.status(403).json({ error: 'Only Master can manage permissions' });
    
    const { id } = req.params;
    const { permissions } = req.body; // Expects object { viewUsers: true, canGrantPro: true, ... }
    const memoryStore = req.app.locals.memoryStore;

    const user = memoryStore.users.get(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (user.role === 'master') return res.status(403).json({ error: 'Cannot modify Master permissions' });

    user.permissions = permissions;
    memoryStore.users.set(id, user);
    memoryStore.save();
    
    logAction(req, 'UPDATE_PERMISSIONS', id, { permissions });
    
    const { password: _, ...userSafe } = user;
    res.json(userSafe);
});

// Update Password (Authenticated User or Master)
router.put('/:id/password', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { newPassword } = req.body;
    const memoryStore = req.app.locals.memoryStore;

    // Check permissions: User can change their own, Master can change anyone's
    if (req.userId !== id && req.userRole !== 'master') {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const user = memoryStore.users.get(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Validate password strength (basic)
    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    user.password = hashedPassword;
    
    memoryStore.users.set(id, user);
    memoryStore.save();

    logAction(req, 'CHANGE_PASSWORD', id);

    res.json({ message: 'Password updated successfully' });
});

// Delete User/Admin (Master only)
router.delete('/:id', verifyToken, (req, res) => {
    if (req.userRole !== 'master') return res.status(403).json({ error: 'Only Master can delete users' });

    const { id } = req.params;
    const memoryStore = req.app.locals.memoryStore;
    
    const user = memoryStore.users.get(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (user.role === 'master') return res.status(403).json({ error: 'Cannot delete Master user' });

    memoryStore.users.delete(id);
    memoryStore.save();

    logAction(req, 'DELETE_USER', id);

    res.json({ message: 'User deleted successfully', userId: id });
});

// Grant PRO
router.post('/:id/upgrade', verifyToken, checkPermission('canGrantPro'), (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  
  // Sync mock users to ensure consistency
  syncMockUsers(memoryStore);
  
  // Check global setting
  const freeUpgradeEnabled = memoryStore.settings.get('free_upgrade_enabled');
  if (req.userRole !== 'master' && freeUpgradeEnabled === false) {
      return res.status(403).json({ error: 'Free upgrades are currently disabled by Master Admin.' });
  }

  const { id } = req.params;
  
  const user = memoryStore.users.get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.isPro = true;
  memoryStore.users.set(id, user);
  memoryStore.save();

  logAction(req, 'UPGRADE_PRO', id);
  
  res.json({ message: 'User upgraded to PRO', userId: id, isPro: true });
});

// Revoke PRO
router.post('/:id/downgrade', verifyToken, checkPermission('canGrantPro'), (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  
  // Sync mock users to ensure consistency
  syncMockUsers(memoryStore);

  // Check global setting (Should downgrades also be blocked? Requirement says "ativar/desativar a funcionalidade de upgrade gratuito". Strictly upgrades. But usually implies managing the feature. Let's block both for consistency, or just upgrade. User said "upgrade gratuito". I will stick to blocking upgrade only as per strict text, but practically blocking both prevents circumvention. Let's block upgrade only for now as it's the specific "free gift".)
  // Actually, let's block both to be safe, or ask user. 
  // User text: "ativar/desativar a funcionalidade de upgrade gratuito".
  // I will block UPGRADE only. Downgrade is fixing a mistake or punishment, usually allowed.
  
  const { id } = req.params;
  
  const user = memoryStore.users.get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.isPro = false;
  memoryStore.users.set(id, user);
  memoryStore.save();

  logAction(req, 'DOWNGRADE_PRO', id);
  
  res.json({ message: 'User downgraded from PRO', userId: id, isPro: false });
});

// Reset Credits (Admin/Master with manageUsers permission)
router.post(
  '/:id/reset-credits',
  verifyToken,
  checkPermission('manageUsers'),
  (req, res) => {
    const { id } = req.params;
    const memoryStore = req.app.locals.memoryStore;

    const user = memoryStore.users.get(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.credits = 0;
    memoryStore.users.set(id, user);

    if (!memoryStore.transactions) memoryStore.transactions = [];
    memoryStore.transactions.push({
      id: uuidv4(),
      userId: id,
      amount: 0,
      amountBrl: 0,
      type: 'reset_credits',
      provider: 'admin',
      providerId: `reset-${Date.now()}`,
      status: 'completed',
      bankStatus: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      processedBy: req.userId,
      reason: 'RESET_CREDITS',
    });

    memoryStore.save();

    logAction(req, 'RESET_CREDITS', id);
    console.log(`[Credits][RESET] Admin ${req.userId} reset credits for ${id}`);

    const { password: _, ...userSafe } = user;
    res.json({ message: 'User credits reset to 0', user: userSafe });
  },
);

// Grant Credits (single user)
router.post(
  '/:id/credits/grant',
  verifyToken,
  requireAdminOrMaster,
  (req, res) => {
    const { id } = req.params;
    const { amount, reason, expiryDate } = req.body || {};
    const memoryStore = req.app.locals.memoryStore;

    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount <= 0
    ) {
      return res
        .status(400)
        .json({ success: false, error: 'Quantidade de créditos inválida.' });
    }

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res
        .status(400)
        .json({ success: false, error: 'Motivo da concessão é obrigatório.' });
    }

    const user = memoryStore.users.get(id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: 'User not found' });
    }

    const currentCredits =
      typeof user.credits === 'number' && Number.isFinite(user.credits)
        ? user.credits
        : 0;

    const newCredits = currentCredits + amount;
    user.credits = newCredits;
    memoryStore.users.set(id, user);

    if (!memoryStore.transactions) memoryStore.transactions = [];
    const txId = uuidv4();
    memoryStore.transactions.push({
      id: txId,
      userId: id,
      amount,
      amountBrl: 0,
      type: 'manual_grant',
      provider: 'admin',
      providerId: `manual-grant-${txId}`,
      status: 'completed',
      bankStatus: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      processedBy: req.userId,
      reason: reason.trim(),
      expiryDate: expiryDate || null,
    });

    memoryStore.save();

    logAction(req, 'GRANT_CREDITS', id, {
      amount,
      reason: reason.trim(),
      previousCredits: currentCredits,
      newCredits,
    });

    console.log(
      `[Credits][GRANT] Admin ${req.userId} granted ${amount} credits to ${id}. Total: ${newCredits}`,
    );

    const { password: _, ...userSafe } = user;
    res.json({
      success: true,
      message: 'Créditos concedidos com sucesso',
      user: userSafe,
    });
  },
);

// Revoke Credits (single user)
router.post(
  '/:id/credits/revoke',
  verifyToken,
  requireAdminOrMaster,
  (req, res) => {
    const { id } = req.params;
    const { amount, reason } = req.body || {};
    const memoryStore = req.app.locals.memoryStore;

    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount <= 0
    ) {
      return res
        .status(400)
        .json({ success: false, error: 'Quantidade de créditos inválida.' });
    }

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res
        .status(400)
        .json({ success: false, error: 'Motivo da reversão é obrigatório.' });
    }

    const user = memoryStore.users.get(id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: 'User not found' });
    }

    const currentCredits =
      typeof user.credits === 'number' && Number.isFinite(user.credits)
        ? user.credits
        : 0;

    if (currentCredits <= 0 || amount > currentCredits) {
      return res.status(400).json({
        success: false,
        error:
          'Reversão inválida: usuário não possui créditos suficientes para esta operação.',
      });
    }

    const newCredits = currentCredits - amount;
    user.credits = newCredits;
    memoryStore.users.set(id, user);

    if (!memoryStore.transactions) memoryStore.transactions = [];
    const txId = uuidv4();
    memoryStore.transactions.push({
      id: txId,
      userId: id,
      amount: -amount,
      amountBrl: 0,
      type: 'manual_revoke',
      provider: 'admin',
      providerId: `manual-revoke-${txId}`,
      status: 'completed',
      bankStatus: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      processedBy: req.userId,
      reason: reason.trim(),
    });

    memoryStore.save();

    logAction(req, 'REVOKE_CREDITS', id, {
      amount,
      reason: reason.trim(),
      previousCredits: currentCredits,
      newCredits,
    });

    console.log(
      `[Credits][REVOKE] Admin ${req.userId} revoked ${amount} credits from ${id}. Total: ${newCredits}`,
    );

    const { password: _, ...userSafe } = user;
    res.json({
      success: true,
      message: 'Créditos revertidos com sucesso',
      user: userSafe,
    });
  },
);

router.get(
  '/:id/credits/history',
  verifyToken,
  requireAdminOrMaster,
  (req, res) => {
    const { id } = req.params;
    const memoryStore = req.app.locals.memoryStore;

    if (!memoryStore || !memoryStore.users) {
      return res
        .status(503)
        .json({ success: false, error: 'Store not initialized' });
    }

    const user = memoryStore.users.get(id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: 'User not found' });
    }

    const transactions = Array.isArray(memoryStore.transactions)
      ? memoryStore.transactions
      : [];

    const allowedTypes = new Set([
      'grant',
      'manual_grant',
      'manual_revoke',
      'manual_grant_bulk',
    ]);

    const history = transactions
      .filter((tx) => {
        if (!tx || typeof tx.type !== 'string') return false;
        if (!allowedTypes.has(tx.type)) return false;
        if (tx.type === 'manual_grant_bulk') {
          return true;
        }
        return tx.userId === id;
      })
      .map((tx) => {
        const createdAt =
          typeof tx.createdAt === 'string' && tx.createdAt.trim().length > 0
            ? tx.createdAt
            : new Date().toISOString();

        let reason = tx.reason;
        if (!reason || typeof reason !== 'string' || !reason.trim()) {
          if (tx.type === 'grant') {
            const provider =
              typeof tx.provider === 'string' && tx.provider.length > 0
                ? tx.provider.toUpperCase()
                : 'PAGAMENTO';
            reason = `Créditos via ${provider}`;
          } else if (tx.type === 'manual_grant') {
            reason = 'Créditos concedidos manualmente';
          } else if (tx.type === 'manual_revoke') {
            reason = 'Créditos revertidos manualmente';
          } else {
            reason = 'Ajuste de créditos';
          }
        }

        return {
          id: tx.id,
          amount:
            typeof tx.amount === 'number' && Number.isFinite(tx.amount)
              ? tx.amount
              : 0,
          type: tx.type,
          reason: reason.trim(),
          adminId:
            typeof tx.processedBy === 'string' && tx.processedBy.length > 0
              ? tx.processedBy
              : null,
          timestamp: createdAt,
          expiryDate:
            typeof tx.expiryDate === 'string' && tx.expiryDate.length > 0
              ? tx.expiryDate
              : null,
        };
      })
      .sort((a, b) => {
        const aTime = new Date(a.timestamp).getTime();
        const bTime = new Date(b.timestamp).getTime();
        return aTime - bTime;
      });

    res.json({ success: true, data: history });
  },
);

// Grant Credits in bulk to all active users
router.post(
  '/credits/grant-bulk',
  verifyToken,
  requireAdminOrMaster,
  (req, res) => {
    const { amount, reason, expiryDate } = req.body || {};
    const memoryStore = req.app.locals.memoryStore;

    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount <= 0
    ) {
      return res
        .status(400)
        .json({ success: false, error: 'Quantidade de créditos inválida.' });
    }

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res
        .status(400)
        .json({ success: false, error: 'Motivo da concessão é obrigatório.' });
    }

    const users = Array.from(memoryStore.users.values());
    let affected = 0;

    users.forEach((user) => {
      if (user.status === 'blocked') {
        return;
      }
      const currentCredits =
        typeof user.credits === 'number' && Number.isFinite(user.credits)
          ? user.credits
          : 0;
      const newCredits = currentCredits + amount;
      user.credits = newCredits;
      memoryStore.users.set(user.id, user);
      affected += 1;
    });

    if (!memoryStore.transactions) memoryStore.transactions = [];
    const txId = uuidv4();
    memoryStore.transactions.push({
      id: txId,
      userId: null,
      amount,
      amountBrl: 0,
      type: 'manual_grant_bulk',
      provider: 'admin',
      providerId: `manual-grant-bulk-${txId}`,
      status: 'completed',
      bankStatus: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      processedBy: req.userId,
      reason: reason.trim(),
      expiryDate: expiryDate || null,
      affectedUsers: affected,
    });

    memoryStore.save();

    logAction(req, 'GRANT_CREDITS_BULK', 'ALL', {
      amount,
      reason: reason.trim(),
      affectedUsers: affected,
    });

    console.log(
      `[Credits][GRANT_BULK] Admin ${req.userId} granted ${amount} credits to ${affected} users.`,
    );

    res.json({
      success: true,
      message: 'Créditos concedidos para todos os usuários ativos',
      affectedUsers: affected,
    });
  },
);

// Update User Status (active/blocked) - Admin/Master with manageUsers permission
router.post('/:id/status', verifyToken, checkPermission('manageUsers'), (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const memoryStore = req.app.locals.memoryStore;

  if (status !== 'active' && status !== 'blocked') {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  const user = memoryStore.users.get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.role === 'master') {
    return res.status(403).json({ error: 'Cannot change Master status' });
  }

  user.status = status;
  memoryStore.users.set(id, user);
  memoryStore.save();

  logAction(req, 'CHANGE_STATUS', id, { status });

  const { password: _, ...userSafe } = user;
  res.json({ message: 'User status updated', user: userSafe });
});

// Toggle Free Upgrade Feature (Global Setting - Master Only)
router.post('/settings/free-upgrade', verifyToken, (req, res) => {
    if (req.userRole !== 'master') return res.status(403).json({ error: 'Forbidden' });
    
    const { enabled } = req.body;
    const memoryStore = req.app.locals.memoryStore;
    
    memoryStore.settings.set('free_upgrade_enabled', enabled);
    memoryStore.save();
    
    logAction(req, 'TOGGLE_FREE_UPGRADE', 'system', { enabled });
    
    res.json({ message: 'Setting updated', enabled });
});

// Get Free Upgrade Status (Authenticated)
router.get('/settings/free-upgrade', verifyToken, (req, res) => {
    const memoryStore = req.app.locals.memoryStore;
    const enabled = memoryStore.settings.get('free_upgrade_enabled');
    // Default to true if not set
    res.json({ success: true, data: enabled !== false });
});

// Audit Logs (Master only)
router.get('/audit-logs', verifyToken, (req, res) => {
    if (req.userRole !== 'master') return res.status(403).json({ error: 'Forbidden' });
    const memoryStore = req.app.locals.memoryStore;
    res.json(memoryStore.audit_logs);
});

export default router;
