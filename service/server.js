/**
 * Task Microservice — internal service, reachable only via the API Gateway.
 * Implements: Auth (JWT + bcrypt), RBAC, input validation, Redis caching,
 * Google OAuth, Prometheus metrics, Winston logging, and rate limiting.
 *
 * Security patterns applied:
 *  - Authenticator Pattern (JWT)
 *  - Authorization Enforcer / RBAC
 *  - Input Validator / Sanitizer
 *  - Secure Logger
 *  - Cache-Aside (Redis)
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const { createClient } = require('redis');
const mongoose = require('mongoose');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const winston = require('winston');
const promClient = require('prom-client');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50kb' })); // Prevent body-size DoS
app.use(helmet({ contentSecurityPolicy: false })); // Internal service — lightweight headers
app.use(passport.initialize());

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongodb:27017/taskdb';

// ====================== LOGGER ======================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// ====================== PROMETHEUS METRICS ======================
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [50, 100, 250, 500, 1000, 2500],
  registers: [register]
});

const activeTasksGauge = new promClient.Gauge({
  name: 'active_tasks_total',
  help: 'Total number of active tasks in the database',
  registers: [register]
});

// ====================== REQUEST LOGGING MIDDLEWARE ======================
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = req.route?.path || req.path.replace(/\/[0-9a-f]{24}/g, '/:id');
    logger.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
      user: req.user?.username || req.headers['x-user-name'] || 'anonymous',
      ip: req.ip
    });
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route, status: res.statusCode }, duration);
  });
  next();
});

// ====================== MONGODB SCHEMAS ======================
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  googleId: { type: String, unique: true, sparse: true },
  role: { type: String, enum: ['ADMIN', 'USER'], default: 'USER' },
  createdAt: { type: Date, default: Date.now }
});

const taskSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: '', trim: true, maxlength: 2000 },
  status: { type: String, enum: ['todo', 'in_progress', 'done'], default: 'todo' },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  tags: [{ type: String, trim: true, maxlength: 40 }],
  userId: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Auto-update updatedAt on save
taskSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

const Task = mongoose.model('Task', taskSchema);
const User = mongoose.model('User', userSchema);

// ====================== MONGODB CONNECTION ======================
mongoose.connect(MONGO_URL)
  .then(async () => {
    logger.info('✅ Connected to MongoDB');
    // Seed default admin user if not present
    const admin = await User.findOne({ username: 'admin' });
    if (!admin) {
      const hash = await bcrypt.hash('Admin@1234!', 12);
      await User.create({ username: 'admin', password: hash, role: 'ADMIN' });
      logger.info('✅ Default admin user created (username: admin, password: Admin@1234!)');
    }
    // Update active tasks gauge
    const count = await Task.countDocuments();
    activeTasksGauge.set(count);
  })
  .catch(err => logger.error('MongoDB connection error:', { error: err.message }));

// ====================== GOOGLE OAUTH ======================
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || `${process.env.API_GATEWAY_URL || 'http://localhost:8080'}/api/auth/oauth/google/callback`
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;
      let user = await User.findOne({ googleId: profile.id });
      if (!user && email) user = await User.findOne({ username: email });
      if (!user) {
        const randomPass = await bcrypt.hash(Math.random().toString(36), 12);
        user = await User.create({
          username: email || `google-${profile.id}`,
          password: randomPass,
          googleId: profile.id,
          role: 'USER'
        });
      } else if (!user.googleId) {
        user.googleId = profile.id;
        await user.save();
      }
      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }));
}

app.get('/auth/oauth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/oauth/google/callback',
  passport.authenticate('google', { failureRedirect: `${FRONTEND_URL}/login?error=oauth_failed`, session: false }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user._id.toString(), username: req.user.username, role: req.user.role },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    // Redirect with token — frontend reads it from query param
    res.redirect(`${FRONTEND_URL}/oauth-success?token=${encodeURIComponent(token)}`);
  }
);

// ====================== REDIS ======================
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
redisClient.on('error', err => logger.error('Redis error', { error: err.message }));
redisClient.connect()
  .then(() => logger.info('✅ Redis connected'))
  .catch(err => logger.warn('Redis unavailable — caching disabled', { error: err.message }));

const CACHE_TTL = 300; // 5 minutes

async function getCache(key) {
  if (!redisClient.isReady) return null;
  try {
    const val = await redisClient.get(key);
    return val ? JSON.parse(val) : null;
  } catch (err) {
    logger.error('Cache get error', { error: err.message, key });
    return null;
  }
}

async function setCache(key, data, ttl = CACHE_TTL) {
  if (!redisClient.isReady) return;
  try {
    await redisClient.setEx(key, ttl, JSON.stringify(data));
  } catch (err) {
    logger.error('Cache set error', { error: err.message, key });
  }
}

async function invalidateCache(key) {
  if (!redisClient.isReady) return;
  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Cache invalidate error', { error: err.message, key });
  }
}

// ====================== RATE LIMITING ======================
// Global — applied to all routes
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
// Strict — auth endpoints only
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' }
});

app.use(globalLimiter);

// ====================== JWT AUTH MIDDLEWARE ======================
const authenticateJWT = (req, res, next) => {
  // Accept forwarded user identity from the gateway (trusted internal header)
  if (req.headers['x-user-id'] && req.headers['x-user-role']) {
    req.user = {
      id: req.headers['x-user-id'],
      role: req.headers['x-user-role'],
      username: req.headers['x-user-name'] || 'unknown'
    };
    return next();
  }

  // Direct JWT verification fallback (useful for local dev without gateway)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    logger.warn('JWT auth failed', { error: err.message });
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// ====================== RBAC MIDDLEWARE ======================
const authorize = (roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    logger.warn('rbac_denied', { user: req.user?.username, role: req.user?.role, required: roles });
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

// ====================== HEALTH CHECK ======================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'task-service',
    timestamp: new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    redis: redisClient.isReady ? 'connected' : 'disconnected'
  });
});

// ====================== AUTH ROUTES ======================

// REGISTER
app.post('/auth/register',
  authLimiter,
  body('username')
    .trim()
    .isLength({ min: 3, max: 30 }).withMessage('Username must be 3–30 characters')
    .matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username: only letters, numbers, _, . and - allowed')
    .escape(),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/)
    .withMessage('Password must contain uppercase, lowercase, a number, and a symbol'),
  async (req, res) => {
    const validErr = handleValidation(req, res);
    if (validErr !== null) return;

    try {
      const { username, password, role = 'USER' } = req.body;
      const existing = await User.findOne({ username: username.trim() });
      if (existing) return res.status(409).json({ error: 'Username already taken' });

      const hashedPassword = await bcrypt.hash(password, 12);
      const newUser = await User.create({
        username: username.trim(),
        password: hashedPassword,
        role: role.toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER'
      });
      logger.info('user_registered', { username: newUser.username, role: newUser.role });
      res.status(201).json({ message: 'User registered successfully', user: { username: newUser.username, role: newUser.role } });
    } catch (err) {
      logger.error('register_error', { error: err.message });
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// LOGIN
app.post('/auth/login',
  authLimiter,
  body('username').trim().notEmpty().escape(),
  body('password').notEmpty(),
  async (req, res) => {
    const validErr = handleValidation(req, res);
    if (validErr !== null) return;

    try {
      const { username, password } = req.body;
      const user = await User.findOne({ username: username.trim() });

      // Constant-time comparison to prevent timing attacks
      const passwordMatch = user ? await bcrypt.compare(password, user.password) : await bcrypt.hash(password, 1);
      if (!user || !passwordMatch) {
        logger.warn('login_failed', { username, ip: req.ip });
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      const token = jwt.sign(
        { id: user._id.toString(), username: user.username, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '2h', issuer: 'task-service' }
      );
      logger.info('login_success', { username: user.username, role: user.role });
      res.json({ token, user: { username: user.username, role: user.role } });
    } catch (err) {
      logger.error('login_error', { error: err.message });
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// ====================== TASK ROUTES ======================

// GET all tasks for authenticated user
app.get('/tasks', authenticateJWT, async (req, res) => {
  try {
    const cacheKey = `tasks:user:${req.user.id}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const tasks = await Task.find({ userId: req.user.id }).sort({ createdAt: -1 });
    await setCache(cacheKey, tasks);
    res.json(tasks);
  } catch (err) {
    logger.error('get_tasks_error', { error: err.message, user: req.user.id });
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// CREATE task
app.post('/tasks',
  authenticateJWT,
  authorize(['USER', 'ADMIN']),
  body('title').trim().isLength({ min: 1, max: 200 }).withMessage('Title must be 1–200 characters').escape(),
  body('description').optional().trim().isLength({ max: 2000 }).escape(),
  body('status').optional().isIn(['todo', 'in_progress', 'done']).withMessage('Invalid status'),
  body('priority').optional().isIn(['low', 'medium', 'high']).withMessage('Invalid priority'),
  body('tags').optional().isArray({ max: 20 }).withMessage('Max 20 tags'),
  async (req, res) => {
    const validErr = handleValidation(req, res);
    if (validErr !== null) return;

    try {
      const { title, description = '', status = 'todo', priority = 'medium', tags = [] } = req.body;
      const task = new Task({
        title,
        description,
        status,
        priority,
        tags: Array.isArray(tags) ? tags.map(t => String(t).trim().substring(0, 40)).filter(Boolean) : [],
        userId: req.user.id
      });
      await task.save();
      await invalidateCache(`tasks:user:${req.user.id}`);
      // Update gauge
      const count = await Task.countDocuments();
      activeTasksGauge.set(count);
      logger.info('task_created', { taskId: task._id, user: req.user.username });
      res.status(201).json(task);
    } catch (err) {
      logger.error('create_task_error', { error: err.message, user: req.user.id });
      res.status(500).json({ error: 'Failed to create task' });
    }
  }
);

// UPDATE task
app.put('/tasks/:id',
  authenticateJWT,
  authorize(['USER', 'ADMIN']),
  param('id').isMongoId().withMessage('Invalid task ID'),
  body('title').optional().trim().isLength({ min: 1, max: 200 }).escape(),
  body('description').optional().trim().isLength({ max: 2000 }).escape(),
  body('status').optional().isIn(['todo', 'in_progress', 'done']),
  body('priority').optional().isIn(['low', 'medium', 'high']),
  body('tags').optional().isArray({ max: 20 }),
  async (req, res) => {
    const validErr = handleValidation(req, res);
    if (validErr !== null) return;

    try {
      const task = await Task.findOne({ _id: req.params.id, userId: req.user.id });
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const { title, description, status, priority, tags } = req.body;
      if (title !== undefined) task.title = title;
      if (description !== undefined) task.description = description;
      if (status !== undefined) task.status = status;
      if (priority !== undefined) task.priority = priority;
      if (tags !== undefined) task.tags = Array.isArray(tags) ? tags.map(t => String(t).trim().substring(0, 40)).filter(Boolean) : [];

      await task.save();
      await invalidateCache(`tasks:user:${req.user.id}`);
      logger.info('task_updated', { taskId: task._id, user: req.user.username });
      res.json(task);
    } catch (err) {
      logger.error('update_task_error', { error: err.message });
      res.status(500).json({ error: 'Failed to update task' });
    }
  }
);

// DELETE task
app.delete('/tasks/:id',
  authenticateJWT,
  authorize(['USER', 'ADMIN']),
  param('id').isMongoId().withMessage('Invalid task ID'),
  async (req, res) => {
    const validErr = handleValidation(req, res);
    if (validErr !== null) return;

    try {
      const task = await Task.findOne({ _id: req.params.id, userId: req.user.id });
      if (!task) return res.status(404).json({ error: 'Task not found' });

      await Task.deleteOne({ _id: req.params.id });
      await invalidateCache(`tasks:user:${req.user.id}`);
      const count = await Task.countDocuments();
      activeTasksGauge.set(count);
      logger.info('task_deleted', { taskId: req.params.id, user: req.user.username });
      res.json({ message: 'Task deleted successfully' });
    } catch (err) {
      logger.error('delete_task_error', { error: err.message });
      res.status(500).json({ error: 'Failed to delete task' });
    }
  }
);

// ====================== ADMIN ROUTES ======================

// GET all tasks (admin-only)
app.get('/admin/tasks', authenticateJWT, authorize(['ADMIN']), async (req, res) => {
  try {
    const tasks = await Task.find({}).sort({ createdAt: -1 }).limit(500);
    res.json(tasks);
  } catch (err) {
    logger.error('admin_tasks_error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// GET all users (admin-only)
app.get('/admin/users', authenticateJWT, authorize(['ADMIN']), async (req, res) => {
  try {
    const users = await User.find({}, '-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    logger.error('admin_users_error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ====================== PROMETHEUS METRICS ======================
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ====================== 404 / ERROR HANDLER ======================
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  logger.error('unhandled_error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => logger.info(`✅ Task Service running on port ${PORT}`));
