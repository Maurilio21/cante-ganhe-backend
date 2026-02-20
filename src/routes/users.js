import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
export const SECRET_KEY = process.env.JWT_SECRET || 'secret_key_dev';

// Middleware to verify JWT
export const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    // For dev convenience, if no token, check if we want to allow anonymous for some reason?
    // No, requirement says "autenticação baseada em JWT".
    return res.status(403).json({ error: 'No token provided' });
  }

  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Unauthorized' });
    req.userId = decoded.id;
    req.userRole = decoded.role;
    req.permissions = decoded.permissions || {};
    next();
  });
};

// Middleware to check permissions
export const checkPermission = (permission) => {
  return (req, res, next) => {
    // Master always has permission
    if (req.userRole === 'master') return next();
    
    // Check specific permission
    if (req.permissions && req.permissions[permission]) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
  };
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
    const { name, email, phone, password } = req.body;
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
  let user = Array.from(memoryStore.users.values()).find(u => u.email === email);

  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) return res.status(401).json({ error: 'Invalid password' });

  const normalizedCredits =
    typeof user.credits === 'number' && Number.isFinite(user.credits)
      ? user.credits
      : 0;

  user.credits = normalizedCredits;
  memoryStore.users.set(user.id, user);
  memoryStore.save();

  const token = jwt.sign({ 
    id: user.id, 
    role: user.role, 
    permissions: user.permissions 
  }, SECRET_KEY, { expiresIn: '24h' });

  const { password: _, ...userSafe } = user;
  res.json({ token, user: userSafe });
});

// List Users
router.get('/', verifyToken, checkPermission('viewUsers'), (req, res) => {
  const memoryStore = req.app.locals.memoryStore;
  syncMockUsers(memoryStore); // Ensure users exist
  const users = Array.from(memoryStore.users.values()).map(({ password, ...u }) => u);
  res.json(users);
});

// Create User (Public/Authenticated) - For Admin Panel "Add User" or Registration
router.post('/', verifyToken, checkPermission('viewUsers'), (req, res) => {
    // Note: 'viewUsers' permission allows adding users too for now, or we can add 'manageUsers'
    // The requirement implies Master/Admin can add users.
    
    const { name, email, phone, password } = req.body;
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
router.post('/:id/reset-credits', verifyToken, checkPermission('manageUsers'), (req, res) => {
  const { id } = req.params;
  const memoryStore = req.app.locals.memoryStore;

  const user = memoryStore.users.get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.credits = 0;
  memoryStore.users.set(id, user);
  memoryStore.save();

  logAction(req, 'RESET_CREDITS', id);

  const { password: _, ...userSafe } = user;
  res.json({ message: 'User credits reset to 0', user: userSafe });
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
