/**
 * Task Microservice — internal service, reachable only via the API Gateway.
 *
 * Features:
 *  - JWT Authentication + Google OAuth 2.0 (FIXED: routes guarded properly)
 *  - RBAC (admin / user / shared-task permissions)
 *  - Input validation + sanitization (express-validator, body-size limit)
 *  - Redis caching + cache invalidation
 *  - Prometheus metrics (counters, histograms, gauges)
 *  - Winston structured logging
 *  - Audit / activity log (who did what, when)
 *  - Task sharing with per-user permission levels (read / edit)
 *  - Subtasks / checklists
 *  - Due-date support + recurring tasks
 *  - CSV / JSON export with injection-safe encoding
 *  - Rate limiting (global + per-auth-endpoint)
 *
 * Security patterns: Authenticator, RBAC Enforcer, Input Validator,
 *                    Secure Logger, Cache-Aside, Least Privilege
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const { body, param, validationResult } = require('express-validator');
const { createClient } = require('redis');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const winston = require('winston');
const promClient = require('prom-client');
const helmet = require('helmet');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(helmet({ contentSecurityPolicy: false }));

// ====================== EMAIL (Nodemailer) ======================
// Gmail App Password setup:
//   1. myaccount.google.com → Security → 2-Step Verification → App Passwords
//   2. Generate → copy the 16-char password → paste as SMTP_PASS (dashes optional, Gmail ignores them)
let mailer = null;
const _smtpUser = (process.env.SMTP_USER || '').trim();
const _smtpPass = (process.env.SMTP_PASS || '').trim();
const _smtpHost = (process.env.SMTP_HOST || '').trim();

if (_smtpHost && _smtpUser && _smtpPass) {
  const port   = parseInt(process.env.SMTP_PORT || '587');
  const secure = port === 465;          // true = TLS from start (port 465)
                                        // false + requireTLS = STARTTLS (port 587) ← Gmail standard
  mailer = nodemailer.createTransport({
    host:   _smtpHost,
    port,
    secure,
    requireTLS: !secure,                // force STARTTLS on port 587
    auth:   { user: _smtpUser, pass: _smtpPass },
    tls:    { rejectUnauthorized: false }  // allow self-signed certs in dev
  });
  // Verify connection at startup so errors appear in docker logs immediately
  mailer.verify()
    .then(() => console.info(`[email] ✅ SMTP ready — ${_smtpUser} via ${_smtpHost}:${port}`))
    .catch(err => console.error(`[email] ❌ SMTP connection FAILED: ${err.message}\n` +
      '  → Check SMTP_USER, SMTP_PASS (must be a Gmail App Password), and that 2FA is enabled'));
} else {
  console.warn('[email] ⚠ SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
}

async function sendEmail(to, subject, html) {
  if (!mailer) return false;
  try {
    const from = (process.env.SMTP_FROM || '').trim() || `"Tasken" <${_smtpUser}>`;
    await mailer.sendMail({ from, to, subject, html });
    console.info('[email] ✅ Sent to', to);
    return true;
  } catch (err) {
    console.error('[email] ❌ Failed to send to', to, ':', err.message);
    return false;
  }
}

const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongodb:27017/taskdb';

// ====================== LOGGER ======================
// ====================== LOGGER ======================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// ====================== PROMETHEUS ======================
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total', help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'], registers: [register]
});
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_ms', help: 'Request latency ms',
  labelNames: ['method', 'route', 'status'],
  buckets: [50, 100, 250, 500, 1000, 2500], registers: [register]
});
const activeTasksGauge = new promClient.Gauge({
  name: 'active_tasks_total', help: 'Total tasks in DB', registers: [register]
});

// ====================== REQUEST LOGGING ======================
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms    = Date.now() - start;
    const route = req.route?.path || req.path.replace(/\/[0-9a-f]{24}/g, '/:id');
    logger.info('request', { method: req.method, path: req.path, status: res.statusCode, ms, user: req.user?.username || req.headers['x-user-name'] || 'anon', ip: req.ip });
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route, status: res.statusCode }, ms);
  });
  next();
});

// ====================== SCHEMAS ======================
const userSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true, trim: true },
  email:     { type: String, unique: true, sparse: true, trim: true, lowercase: true },
  password:  { type: String, required: true },
  googleId:  { type: String, unique: true, sparse: true },
  role:      { type: String, enum: ['ADMIN', 'USER'], default: 'USER' },
  createdAt: { type: Date, default: Date.now }
});

const subtaskSchema = new mongoose.Schema({
  title:     { type: String, required: true, trim: true, maxlength: 200 },
  completed: { type: Boolean, default: false }
}, { _id: true });

const shareSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  username:   { type: String, required: true },
  email:      { type: String, default: '' },
  permission: { type: String, enum: ['read', 'edit'], default: 'read' },
  sharedAt:   { type: Date, default: Date.now }
}, { _id: false });

const notificationSchema = new mongoose.Schema({
  recipientId: { type: String, required: true, index: true },
  type:        { type: String, enum: ['task.shared', 'task.updated', 'task.unshared', 'task.completed'], required: true },
  fromUsername:{ type: String, required: true },
  taskId:      { type: String, required: true },
  taskTitle:   { type: String, required: true },
  permission:  { type: String, default: '' },
  read:        { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', notificationSchema);

const taskSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: '', trim: true, maxlength: 2000 },
  status:      { type: String, enum: ['todo', 'in_progress', 'done'], default: 'todo' },
  priority:    { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  tags:        [{ type: String, trim: true, maxlength: 40 }],
  userId:      { type: String, required: true, index: true },
  dueDate:     { type: Date, default: null },
  subtasks:    [subtaskSchema],
  sharedWith:    [shareSchema],
  lastEditedBy:  { type: String, default: '' },   // username of last editor
  lastEditedAt:  { type: Date, default: null },
  recurring:   { type: String, enum: ['none', 'daily', 'weekly', 'monthly'], default: 'none' },
  order:       { type: Number, default: 0 },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
});
taskSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

// Audit / Activity Log
const auditSchema = new mongoose.Schema({
  userId:     { type: String, required: true, index: true },
  username:   { type: String, required: true },
  action:     { type: String, required: true },
  resourceId: { type: String },
  detail:     { type: mongoose.Schema.Types.Mixed },
  ip:         { type: String },
  createdAt:  { type: Date, default: Date.now, index: true }
});

const Task  = mongoose.model('Task',  taskSchema);
const User  = mongoose.model('User',  userSchema);
const Audit = mongoose.model('Audit', auditSchema);

// ====================== MONGODB ======================
mongoose.connect(MONGO_URL)
  .then(async () => {
    logger.info('Connected to MongoDB');
    const admin = await User.findOne({ username: 'admin' });
    if (!admin) {
      const hash = await bcrypt.hash('Admin@1234!', 12);
      await User.create({ username: 'admin', password: hash, role: 'ADMIN' });
      logger.info('Default admin created (admin / Admin@1234!)');
    }
    activeTasksGauge.set(await Task.countDocuments());
  })
  .catch(err => logger.error('MongoDB error', { error: err.message }));

// ====================== AUDIT HELPER ======================
async function audit(req, action, resourceId, detail = {}) {
  try {
    await Audit.create({
      userId: req.user?.id || 'system', username: req.user?.username || 'system',
      action, resourceId: resourceId?.toString(), detail, ip: req.ip
    });
  } catch (e) { logger.error('audit_write_error', { error: e.message }); }
}

// ====================== GOOGLE OAUTH USER UPSERT ======================
// Called internally by the gateway after Google authenticates the user.
// The gateway passes x-internal-secret header to prove it's a trusted caller.
// This endpoint is NOT exposed externally (only reachable via SERVICE_URL from gateway).
app.post('/auth/oauth/upsert', async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.JWT_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { googleId, email } = req.body;
    if (!googleId) return res.status(400).json({ error: 'googleId required' });

    let user = await User.findOne({ googleId });
    if (!user && email) user = await User.findOne({ username: email });

    if (!user) {
      const pass = await bcrypt.hash(Math.random().toString(36) + Date.now(), 12);
      user = await User.create({
        username: email || `google-${googleId}`,
        password: pass,
        googleId,
        role: 'USER'
      });
      logger.info('oauth_user_created', { username: user.username });
    } else if (!user.googleId) {
      user.googleId = googleId;
      await user.save();
    }

    res.json({ id: user._id.toString(), username: user.username, role: user.role });
  } catch (err) {
    logger.error('oauth_upsert_error', { error: err.message });
    res.status(500).json({ error: 'Failed to upsert OAuth user' });
  }
});

// ====================== REDIS ======================
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
redisClient.on('error', err => logger.error('Redis error', { error: err.message }));
redisClient.connect().then(() => logger.info('Redis connected'))
  .catch(err => logger.warn('Redis unavailable — caching disabled', { error: err.message }));

async function getCache(key) {
  if (!redisClient.isReady) return null;
  try { const v = await redisClient.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function setCache(key, data, ttl = 300) {
  if (!redisClient.isReady) return;
  try { await redisClient.setEx(key, ttl, JSON.stringify(data)); } catch {}
}
async function invalidateCache(key) {
  if (!redisClient.isReady) return;
  try { await redisClient.del(key); } catch {}
}

// ====================== RATE LIMITING ======================
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many authentication attempts.' }
});
app.use(globalLimiter);

// ====================== JWT AUTH ======================
const authenticateJWT = (req, res, next) => {
  if (req.headers['x-user-id'] && req.headers['x-user-role']) {
    req.user = { id: req.headers['x-user-id'], role: req.headers['x-user-role'], username: req.headers['x-user-name'] || 'unknown' };
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// ====================== RBAC ======================
const authorize = (roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    logger.warn('rbac_denied', { user: req.user?.username, required: roles });
    return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  }
  next();
};

// ====================== VALIDATION HELPERS ======================
const handleValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  return null;
};

// ====================== HELPERS ======================
const validate = (req, res) => {
  const e = validationResult(req);
  return e.isEmpty() ? null : res.status(400).json({ errors: e.array() });
};

function sanitizeTags(tags) {
  return Array.isArray(tags) ? tags.map(t => String(t).trim().substring(0, 40)).filter(Boolean).slice(0, 20) : [];
}

// CSV injection protection
function csvEscape(val) {
  const s = String(val ?? '').replace(/"/g, '""');
  return /^[=+\-@\t\r]/.test(s) ? `\t${s}` : `"${s}"`;
}

async function getAccessibleTask(taskId, userId, requiredPerm = 'read') {
  const task = await Task.findById(taskId);
  if (!task) return null;
  if (task.userId === userId) return task;
  const share = task.sharedWith.find(s => s.userId === userId);
  if (!share) return null;
  if (requiredPerm === 'edit' && share.permission !== 'edit') return null;
  return task;
}

// ====================== HEALTH ======================
app.get('/health', (req, res) => res.json({
  status: 'healthy', service: 'task-service', timestamp: new Date().toISOString(),
  mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  redis: redisClient.isReady ? 'connected' : 'disconnected'
}));

// ====================== AUTH ROUTES ======================
app.post('/auth/register', authLimiter,
  body('username').trim().isLength({ min: 3, max: 30 }).matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username: 3–30 chars, letters/numbers/._- only').escape(),
  body('email').trim().isEmail().withMessage('A valid email address is required')
    .customSanitizer(v => v.toLowerCase().trim()),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain a lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain a number')
    .matches(/[^A-Za-z0-9]/).withMessage('Password must contain a symbol'),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { username, email, password, role = 'USER' } = req.body;
      if (await User.findOne({ username })) return res.status(409).json({ error: 'Username already taken' });
      if (await User.findOne({ email })) return res.status(409).json({ error: 'Email already registered' });
      const hash = await bcrypt.hash(password, 12);
      const user = await User.create({ username, email, password: hash, role: role.toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER' });
      logger.info('user_registered', { username: user.username, email: user.email });
      res.status(201).json({ message: 'User registered successfully', user: { username: user.username, role: user.role } });
    } catch (err) { logger.error('register_error', { error: err.message }); res.status(500).json({ error: 'Registration failed' }); }
  }
);

app.post('/auth/login', authLimiter,
  body('identifier').trim().notEmpty().withMessage('Username or email is required'),
  body('password').notEmpty().withMessage('Password is required'),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { identifier, password } = req.body;
      // Accept either username or email in the identifier field
      const isEmail = identifier.includes('@');
      const user = isEmail
        ? await User.findOne({ email: identifier.toLowerCase().trim() })
        : await User.findOne({ username: identifier });
      const match = user ? await bcrypt.compare(password, user.password) : (await bcrypt.hash(password, 1), false);
      if (!user || !match) {
        logger.warn('login_failed', { identifier, ip: req.ip });
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const token = jwt.sign({ id: user._id.toString(), username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '2h', issuer: 'task-service' });
      logger.info('login_success', { username: user.username });
      res.json({ token, user: { username: user.username, role: user.role } });
    } catch (err) { logger.error('login_error', { error: err.message }); res.status(500).json({ error: 'Login failed' }); }
  }
);

// Forgot password — looks up account and returns masked info (in prod, would send email)
app.post('/auth/forgot-password', authLimiter,
  body('email').trim().isEmail().withMessage('Please enter a valid email address')
    .customSanitizer(v => v.toLowerCase().trim()),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const user = await User.findOne({ email: req.body.email.toLowerCase().trim() });
      if (!user) return res.status(404).json({ error: 'No account found with that email address.' });

      // Generate and save a temporary password
      const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const rand  = n => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      const tempPassword = `${rand(4)}-${rand(4)}-${rand(4)}`;
      user.password = await bcrypt.hash(tempPassword, 12);
      await user.save();

      const emailSent = await sendEmail(
        user.email,
        'Tasken — Your temporary password',
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="color:#2d4a3e">Your Tasken password</h2>
          <p>You requested a password reset. Here is your temporary password:</p>
          <div style="background:#f5f5f0;padding:16px;border-radius:8px;margin:20px 0;font-size:1.2rem;font-weight:600;color:#2d4a3e;letter-spacing:0.05em">
            ${tempPassword}
          </div>
          <p style="color:#666;font-size:13px">Use this to log in. If you did not request this, please contact support immediately.</p>
          <p style="color:#999;font-size:12px;margin-top:32px">— The Tasken team</p>
        </div>`
      );
      logger.info('forgot_password_sent', { username: user.username, emailSent });
      res.json({
        sent: emailSent,
        message: emailSent
          ? `A temporary password has been sent to ${req.body.email}.`
          : `Email not configured. Temporary password: ${tempPassword}`
      });
    } catch (err) { logger.error('forgot_password_error', { error: err.message }); res.status(500).json({ error: 'Request failed' }); }
  }
);

app.post('/auth/forgot-username', authLimiter,
  body('email').trim().isEmail().withMessage('Please enter a valid email address')
    .customSanitizer(v => v.toLowerCase().trim()),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const user = await User.findOne({ email: req.body.email.toLowerCase().trim() });
      if (!user) return res.json({ sent: false, message: 'If that email is registered, your username has been sent.' });
      const emailSent = await sendEmail(
        user.email,
        'Tasken — Your username',
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="color:#2d4a3e">Your Tasken username</h2>
          <p>You requested your username. Here it is:</p>
          <div style="background:#f5f5f0;padding:16px;border-radius:8px;margin:20px 0;font-size:1.2rem;font-weight:600;color:#2d4a3e;letter-spacing:0.05em">
            ${user.username}
          </div>
          <p style="color:#666;font-size:13px">If you did not request this, you can safely ignore it.</p>
          <p style="color:#999;font-size:12px;margin-top:32px">— The Tasken team</p>
        </div>`
      );
      logger.info('forgot_username_request', { email: req.body.email, emailSent });
      res.json({
        sent: emailSent,
        message: emailSent
          ? `Your username has been sent to ${req.body.email}.`
          : `Email not configured. Your username is: ${user.username}`
      });
    } catch (err) { res.status(500).json({ error: 'Request failed' }); }
  }
);

// ====================== TASK ROUTES ======================

// GET all tasks for authenticated user
app.get('/tasks', authenticateJWT, async (req, res) => {
  try {
    const cacheKey = `tasks:user:${req.user.id}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);
    const ownTasks    = await Task.find({ userId: req.user.id }).sort({ order: 1, createdAt: -1 });
    const sharedTasks = await Task.find({ 'sharedWith.userId': req.user.id }).sort({ createdAt: -1 });
    const all = [...ownTasks, ...sharedTasks.filter(t => t.userId !== req.user.id)];
    await setCache(cacheKey, all);
    res.json(all);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch tasks' }); }
});

app.post('/tasks', authenticateJWT, authorize(['USER', 'ADMIN']),
  body('title').trim().isLength({ min: 1, max: 200 }).escape(),
  body('description').optional().trim().isLength({ max: 2000 }).escape(),
  body('status').optional().isIn(['todo', 'in_progress', 'done']),
  body('priority').optional().isIn(['low', 'medium', 'high']),
  body('tags').optional().isArray({ max: 20 }),
  body('dueDate').optional({ nullable: true }).isISO8601().toDate(),
  body('recurring').optional().isIn(['none', 'daily', 'weekly', 'monthly']),
  body('subtasks').optional().isArray({ max: 50 }),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { title, description = '', status = 'todo', priority = 'medium', tags = [], dueDate = null, recurring = 'none', subtasks = [] } = req.body;
      const last = await Task.findOne({ userId: req.user.id }).sort({ order: -1 }).select('order');
      const task = await Task.create({
        title, description, status, priority, tags: sanitizeTags(tags),
        userId: req.user.id, dueDate, recurring, order: (last?.order ?? -1) + 1,
        subtasks: subtasks.slice(0, 50).map(s => ({ title: String(s.title || '').trim().substring(0, 200), completed: !!s.completed }))
      });
      await invalidateCache(`tasks:user:${req.user.id}`);
      activeTasksGauge.set(await Task.countDocuments());
      await audit(req, 'task.create', task._id, { title });
      res.status(201).json(task);
    } catch (err) { logger.error('create_task_error', { error: err.message }); res.status(500).json({ error: 'Failed to create task' }); }
  }
);

app.put('/tasks/:id', authenticateJWT,
  param('id').isMongoId(),
  body('title').optional().trim().isLength({ min: 1, max: 200 }).escape(),
  body('description').optional().trim().isLength({ max: 2000 }).escape(),
  body('status').optional().isIn(['todo', 'in_progress', 'done']),
  body('priority').optional().isIn(['low', 'medium', 'high']),
  body('tags').optional().isArray({ max: 20 }),
  body('dueDate').optional({ nullable: true }),
  body('recurring').optional().isIn(['none', 'daily', 'weekly', 'monthly']),
  body('subtasks').optional().isArray({ max: 50 }),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const task = await getAccessibleTask(req.params.id, req.user.id, 'edit');
      if (!task) return res.status(404).json({ error: 'Task not found or insufficient permissions' });
      const { title, description, status, priority, tags, dueDate, recurring, subtasks } = req.body;
      const wasComplete = task.status === 'done';
      if (title !== undefined) task.title = title;
      if (description !== undefined) task.description = description;
      if (status !== undefined) task.status = status;
      if (priority !== undefined) task.priority = priority;
      if (tags !== undefined) task.tags = sanitizeTags(tags);
      if (dueDate !== undefined) task.dueDate = dueDate ? new Date(dueDate) : null;
      if (recurring !== undefined) task.recurring = recurring;
      if (subtasks !== undefined) task.subtasks = subtasks.slice(0, 50).map(s => ({
        _id: s._id || new mongoose.Types.ObjectId(),
        title: String(s.title || '').trim().substring(0, 200),
        completed: !!s.completed
      }));

      // Track who last edited (important for collaboration)
      task.lastEditedBy = req.user.username;
      task.lastEditedAt = new Date();

      await task.save();
      await invalidateCache(`tasks:user:${req.user.id}`);
      for (const s of task.sharedWith) await invalidateCache(`tasks:user:${s.userId}`);

      // Notify the task owner when a collaborator makes changes
      const isCollaborator = task.userId !== req.user.id;
      if (isCollaborator) {
        await Notification.create({
          recipientId:  task.userId,
          type:         status === 'done' && !wasComplete ? 'task.completed' : 'task.updated',
          fromUsername: req.user.username,
          taskId:       task._id.toString(),
          taskTitle:    task.title
        });
      }
      // Also notify all OTHER collaborators when anyone edits a shared task
      for (const s of task.sharedWith) {
        if (s.userId !== req.user.id) {
          await Notification.create({
            recipientId:  s.userId,
            type:         status === 'done' && !wasComplete ? 'task.completed' : 'task.updated',
            fromUsername: req.user.username,
            taskId:       task._id.toString(),
            taskTitle:    task.title
          });
        }
      }

      await audit(req, 'task.update', task._id, { changes: Object.keys(req.body), editedBy: req.user.username });
      res.json(task);
    } catch (err) { logger.error('update_task_error', { error: err.message }); res.status(500).json({ error: 'Failed to update task' }); }
  }
);

app.delete('/tasks/:id', authenticateJWT,
  param('id').isMongoId(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const task = await Task.findOne({ _id: req.params.id, userId: req.user.id });
      if (!task) return res.status(404).json({ error: 'Task not found' });
      await Task.deleteOne({ _id: req.params.id });
      await invalidateCache(`tasks:user:${req.user.id}`);
      for (const s of task.sharedWith) await invalidateCache(`tasks:user:${s.userId}`);
      activeTasksGauge.set(await Task.countDocuments());
      await audit(req, 'task.delete', req.params.id, { title: task.title });
      res.json({ message: 'Task deleted successfully' });
    } catch (err) { res.status(500).json({ error: 'Failed to delete task' }); }
  }
);

// Bulk reorder
app.post('/tasks/reorder', authenticateJWT, authorize(['USER', 'ADMIN']),
  body('order').isArray(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      await Task.bulkWrite(req.body.order.map((id, idx) => ({
        updateOne: { filter: { _id: id, userId: req.user.id }, update: { $set: { order: idx } } }
      })));
      await invalidateCache(`tasks:user:${req.user.id}`);
      res.json({ message: 'Tasks reordered' });
    } catch (err) { res.status(500).json({ error: 'Failed to reorder' }); }
  }
);

// ====================== TASK SHARING ======================
app.post('/tasks/:id/share', authenticateJWT,
  param('id').isMongoId(),
  body('identifier').trim().isLength({ min: 1 }).withMessage('Username or email required'),
  body('permission').isIn(['read', 'edit']),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const task = await Task.findOne({ _id: req.params.id, userId: req.user.id });
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Look up by email or username
      const { identifier, permission } = req.body;
      const isEmail = identifier.includes('@');
      const target = isEmail
        ? await User.findOne({ email: identifier.toLowerCase().trim() })
        : await User.findOne({ username: identifier });
      if (!target) return res.status(404).json({ error: isEmail ? 'No user found with that email' : 'No user found with that username' });
      if (target._id.toString() === req.user.id) return res.status(400).json({ error: 'Cannot share with yourself' });

      const existing = task.sharedWith.find(s => s.userId === target._id.toString());
      const isUpdate = !!existing;
      if (existing) {
        existing.permission = permission;
        existing.sharedAt = new Date();
      } else {
        task.sharedWith.push({
          userId: target._id.toString(),
          username: target.username,
          email: target.email || '',
          permission,
          sharedAt: new Date()
        });
      }
      await task.save();
      await invalidateCache(`tasks:user:${target._id}`);
      await invalidateCache(`tasks:user:${req.user.id}`);

      // Create in-app notification for the recipient
      await Notification.create({
        recipientId:  target._id.toString(),
        type:         'task.shared',
        fromUsername: req.user.username,
        taskId:       task._id.toString(),
        taskTitle:    task.title,
        permission
      });

      await audit(req, 'task.share', task._id, { sharedWith: target.username, permission, isUpdate });
      logger.info('task_shared', { taskId: task._id, sharedWith: target.username, permission, by: req.user.username });
      res.json({
        message: `${isUpdate ? 'Updated share for' : 'Shared with'} ${target.username} (${permission})`,
        sharedWith: task.sharedWith
      });
    } catch (err) { logger.error('share_error', { error: err.message }); res.status(500).json({ error: 'Failed to share task' }); }
  }
);

app.delete('/tasks/:id/share/:targetUserId', authenticateJWT, param('id').isMongoId(), async (req, res) => {
  try {
    // Owner can remove anyone; an editor can only remove themselves (leave the task)
    const isSelf = req.params.targetUserId === req.user.id;
    const task = isSelf
      ? await Task.findById(req.params.id)                                    // leaving — find any task
      : await Task.findOne({ _id: req.params.id, userId: req.user.id });     // removing someone else — must be owner
    if (!task) return res.status(404).json({ error: 'Task not found or insufficient permissions' });
    const removed = task.sharedWith.find(s => s.userId === req.params.targetUserId);
    task.sharedWith = task.sharedWith.filter(s => s.userId !== req.params.targetUserId);
    await task.save();
    if (removed) {
      await invalidateCache(`tasks:user:${req.params.targetUserId}`);
      await invalidateCache(`tasks:user:${task.userId}`);  // owner cache must also update
      await Notification.create({
        recipientId:  req.params.targetUserId,
        type:         'task.unshared',
        fromUsername: req.user.username,
        taskId:       task._id.toString(),
        taskTitle:    task.title
      });
    }
    await audit(req, 'task.unshare', task._id, { removedUser: removed?.username || req.params.targetUserId });
    res.json({ message: isSelf ? 'You have left this task' : 'Access removed', sharedWith: task.sharedWith });
  } catch (err) { res.status(500).json({ error: 'Failed to remove share' }); }
});

// ====================== EXPORT / IMPORT ======================
app.get('/tasks/export/json', authenticateJWT, async (req, res) => {
  try {
    const tasks = await Task.find({ userId: req.user.id }).lean();
    await audit(req, 'task.export', null, { format: 'json', count: tasks.length });
    res.setHeader('Content-Disposition', 'attachment; filename="tasks.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json(tasks.map(t => ({ id: t._id, title: t.title, description: t.description, status: t.status, priority: t.priority, tags: t.tags, dueDate: t.dueDate, recurring: t.recurring, subtasks: t.subtasks, createdAt: t.createdAt })));
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

app.get('/tasks/export/csv', authenticateJWT, async (req, res) => {
  try {
    const tasks = await Task.find({ userId: req.user.id }).lean();
    await audit(req, 'task.export', null, { format: 'csv', count: tasks.length });
    const headers = ['id', 'title', 'description', 'status', 'priority', 'tags', 'dueDate', 'recurring', 'createdAt'];
    const rows = tasks.map(t =>
      [t._id, t.title, t.description, t.status, t.priority, (t.tags || []).join(';'), t.dueDate ? new Date(t.dueDate).toISOString() : '', t.recurring, new Date(t.createdAt).toISOString()].map(csvEscape).join(',')
    );
    res.setHeader('Content-Disposition', 'attachment; filename="tasks.csv"');
    res.setHeader('Content-Type', 'text/csv');
    res.send([headers.join(','), ...rows].join('\r\n'));
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

app.post('/tasks/import', authenticateJWT, authorize(['USER', 'ADMIN']),
  body('tasks').isArray({ min: 1, max: 200 }),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const docs = req.body.tasks.map(t => ({
        title:       String(t.title || 'Untitled').trim().substring(0, 200),
        description: String(t.description || '').trim().substring(0, 2000),
        status:      ['todo','in_progress','done'].includes(t.status) ? t.status : 'todo',
        priority:    ['low','medium','high'].includes(t.priority) ? t.priority : 'medium',
        tags:        sanitizeTags(t.tags),
        userId:      req.user.id,
        dueDate:     t.dueDate ? new Date(t.dueDate) : null,
        recurring:   ['none','daily','weekly','monthly'].includes(t.recurring) ? t.recurring : 'none'
      }));
      const inserted = await Task.insertMany(docs);
      await invalidateCache(`tasks:user:${req.user.id}`);
      activeTasksGauge.set(await Task.countDocuments());
      await audit(req, 'task.import', null, { count: inserted.length });
      res.status(201).json({ message: `Imported ${inserted.length} tasks`, count: inserted.length });
    } catch (err) { res.status(500).json({ error: 'Import failed' }); }
  }
);

// ====================== AUDIT LOG ======================
app.get('/audit', authenticateJWT, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    res.json(await Audit.find({ userId: req.user.id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch audit log' }); }
});

// ====================== SUBTASK TOGGLE ======================
// PATCH /tasks/:id/subtasks/:subId — toggle a single subtask without a full PUT
app.patch('/tasks/:id/subtasks/:subId', authenticateJWT,
  param('id').isMongoId(),
  async (req, res) => {
    try {
      const task = await getAccessibleTask(req.params.id, req.user.id, 'edit');
      if (!task) return res.status(404).json({ error: 'Task not found or insufficient permissions' });
      const sub = task.subtasks.id(req.params.subId);
      if (!sub) return res.status(404).json({ error: 'Subtask not found' });
      sub.completed = !sub.completed;
      task.lastEditedBy = req.user.username;
      task.lastEditedAt = new Date();
      await task.save();
      await invalidateCache(`tasks:user:${req.user.id}`);
      for (const s of task.sharedWith) await invalidateCache(`tasks:user:${s.userId}`);
      res.json({ subtaskId: req.params.subId, completed: sub.completed, subtasks: task.subtasks });
    } catch (err) { res.status(500).json({ error: 'Failed to toggle subtask' }); }
  }
);
// Get unread + recent notifications for the current user
app.get('/notifications', authenticateJWT, async (req, res) => {
  try {
    const notifs = await Notification.find({ recipientId: req.user.id })
      .sort({ createdAt: -1 }).limit(50);
    res.json(notifs);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch notifications' }); }
});

// Mark one or all notifications as read
app.patch('/notifications/read', authenticateJWT, async (req, res) => {
  try {
    const { ids } = req.body; // array of ids, or omit to mark all
    const filter = { recipientId: req.user.id, read: false };
    if (ids?.length) filter._id = { $in: ids };
    await Notification.updateMany(filter, { $set: { read: true } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to update notifications' }); }
});

// Delete a notification
app.delete('/notifications/:id', authenticateJWT, async (req, res) => {
  try {
    await Notification.deleteOne({ _id: req.params.id, recipientId: req.user.id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete notification' }); }
});

// ====================== SHARED TASKS (dedicated endpoint) ======================
// Returns only tasks shared WITH the current user (not tasks they own)
app.get('/tasks/shared', authenticateJWT, async (req, res) => {
  try {
    const shared = await Task.find({ 'sharedWith.userId': req.user.id, userId: { $ne: req.user.id } })
      .sort({ updatedAt: -1 });

    // Look up owner usernames in one query
    const ownerIds = [...new Set(shared.map(t => t.userId))];
    const owners   = await User.find({ _id: { $in: ownerIds } }, 'username email').lean();
    const ownerMap = Object.fromEntries(owners.map(u => [u._id.toString(), u.username]));

    const result = shared.map(t => ({
      ...t.toObject(),
      ownerUsername: ownerMap[t.userId] || t.userId
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch shared tasks' }); }
});

// User search — for the share dialog typeahead
app.get('/users/search', authenticateJWT,
  async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json([]);
      const regex = new RegExp(q, 'i');
      const users = await User.find({
        _id: { $ne: req.user.id }, // exclude self
        $or: [{ username: regex }, { email: regex }]
      }, 'username email').limit(8);
      res.json(users.map(u => ({ id: u._id, username: u.username, email: u.email })));
    } catch (err) { res.status(500).json({ error: 'Search failed' }); }
  }
);



app.get('/admin/audit', authenticateJWT, authorize(['ADMIN']), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 100);
    res.json(await Audit.find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch audit log' }); }
});

// ====================== DELETE ACCOUNT ======================
// Change password — requires current password + new password
app.patch('/auth/password', authenticateJWT,
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Must contain an uppercase letter')
    .matches(/[a-z]/).withMessage('Must contain a lowercase letter')
    .matches(/[0-9]/).withMessage('Must contain a number')
    .matches(/[^A-Za-z0-9]/).withMessage('Must contain a symbol'),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const match = await bcrypt.compare(req.body.currentPassword, user.password);
      if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
      user.password = await bcrypt.hash(req.body.newPassword, 12);
      await user.save();
      logger.info('password_changed', { username: user.username });
      res.json({ message: 'Password changed successfully' });
    } catch (err) { logger.error('change_password_error', { error: err.message }); res.status(500).json({ error: 'Failed to change password' }); }
  }
);

app.delete('/auth/account', authenticateJWT,
  body('password').notEmpty().withMessage('Password required to confirm deletion'),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const match = await bcrypt.compare(req.body.password, user.password);
      if (!match) return res.status(401).json({ error: 'Incorrect password' });
      // Delete all the user's tasks, notifications, audit logs, and shared-task entries
      const userTasks = await Task.find({ userId: req.user.id });
      await Task.deleteMany({ userId: req.user.id });
      // Remove user from sharedWith on tasks they were collaborating on
      await Task.updateMany(
        { 'sharedWith.userId': req.user.id },
        { $pull: { sharedWith: { userId: req.user.id } } }
      );
      await Notification.deleteMany({ recipientId: req.user.id });
      await Audit.deleteMany({ userId: req.user.id });
      await User.deleteOne({ _id: req.user.id });
      // Invalidate cache
      await invalidateCache(`tasks:user:${req.user.id}`);
      logger.info('account_deleted', { username: user.username });
      res.json({ message: 'Account deleted successfully' });
    } catch (err) { logger.error('delete_account_error', { error: err.message }); res.status(500).json({ error: 'Failed to delete account' }); }
  }
);

// ====================== ADMIN ======================
app.get('/admin/tasks', authenticateJWT, authorize(['ADMIN']), async (req, res) => {
  try { res.json(await Task.find({}).sort({ createdAt: -1 }).limit(500)); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/admin/users', authenticateJWT, authorize(['ADMIN']), async (req, res) => {
  try { res.json(await User.find({}, '-password').sort({ createdAt: -1 })); }
  catch { res.status(500).json({ error: 'Failed' }); }
});

// ====================== RECURRING TASK SPAWNER ======================
setInterval(async () => {
  try {
    const done = await Task.find({ recurring: { $ne: 'none' }, status: 'done' });
    for (const task of done) {
      const next = new Date(task.updatedAt);
      if (task.recurring === 'daily')   next.setDate(next.getDate() + 1);
      if (task.recurring === 'weekly')  next.setDate(next.getDate() + 7);
      if (task.recurring === 'monthly') next.setMonth(next.getMonth() + 1);
      if (next <= new Date()) {
        await Task.create({ title: task.title, description: task.description, priority: task.priority, tags: task.tags, userId: task.userId, recurring: task.recurring, dueDate: next, status: 'todo', order: task.order });
        task.recurring = 'none'; await task.save();
        logger.info('recurring_spawned', { title: task.title });
      }
    }
  } catch (err) { logger.error('recurring_error', { error: err.message }); }
}, 60 * 1000);

// ====================== PROMETHEUS + CATCH-ALL ======================
app.get('/metrics', async (req, res) => { res.set('Content-Type', register.contentType); res.end(await register.metrics()); });
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => { logger.error('unhandled_error', { error: err.message }); res.status(500).json({ error: 'Internal server error' }); });

app.listen(process.env.PORT || 3001, () => logger.info(`Task Service running on port ${process.env.PORT || 3001}`));
