const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { createClient } = require('redis');
const mongoose = require('mongoose');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const winston = require('winston');
const promClient = require('prom-client');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(passport.initialize());

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongodb:27017/taskdb';

// ====================== LOGGER ======================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// ====================== PROMETHEUS METRICS ======================
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ register: promClient.register });

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status']
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`, {
      user: req.user?.username || 'anonymous',
      ip: req.ip
    });
    httpRequestsTotal.inc({
      method: req.method,
      route: req.route?.path || req.path,
      status: res.statusCode
    });
  });
  next();
});

// ====================== MONGODB ======================
mongoose.connect(MONGO_URL)
  .then(async () => {
    logger.info('✅ Connected to MongoDB');
    const admin = await User.findOne({ username: 'admin' });
    if (!admin) {
      const hashedPassword = await bcrypt.hash('password', 10);
      await User.create({ username: 'admin', password: hashedPassword, role: 'ADMIN' });
      logger.info('✅ Created default admin user');
    }
  })
  .catch(err => logger.error('MongoDB connection error:', err));

const taskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  userId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Task = mongoose.model('Task', taskSchema);

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  googleId: { type: String, unique: true, sparse: true },
  role: { type: String, enum: ['ADMIN', 'USER'], default: 'USER' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || `${process.env.API_GATEWAY_URL || 'http://localhost:8080'}/api/auth/oauth/google/callback`
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value;
    let user = await User.findOne({ googleId: profile.id });
    if (!user && email) {
      user = await User.findOne({ username: email });
    }
    if (!user) {
      const randomPassword = Math.random().toString(36).slice(-12);
      const hashedPassword = await bcrypt.hash(randomPassword, 10);
      user = await User.create({
        username: email || `google-${profile.id}`,
        password: hashedPassword,
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

app.get('/auth/oauth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/oauth/google/callback',
  passport.authenticate('google', { failureRedirect: `${FRONTEND_URL}/oauth-failure`, session: false }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user._id.toString(), username: req.user.username, role: req.user.role },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    res.redirect(`${FRONTEND_URL}/oauth-success?token=${token}`);
  }
);

// ====================== REDIS ======================
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => logger.error('Redis Error', err));
redisClient.connect().then(() => logger.info('✅ Redis Connected'));

const CACHE_TTL = 300;

async function getCache(key) {
  try {
    const value = await redisClient.get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    logger.error('Cache get error:', err);
    return null;
  }
}

async function setCache(key, data, ttl = CACHE_TTL) {
  try {
    if (!redisClient.isReady) return;
    await redisClient.setEx(key, ttl, JSON.stringify(data));
  } catch (err) {
    logger.error('Cache set error:', err);
  }
}

async function invalidateCache(key) {
  try {
    if (!redisClient.isReady) return;
    await redisClient.del(key);
  } catch (err) {
    logger.error('Cache invalidate error:', err);
  }
}

// ====================== MIDDLEWARE ======================
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    logger.error('JWT authentication failed:', err.message);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

const authorize = (roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// ====================== HEALTH CHECK ======================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'task-service',
    timestamp: new Date().toISOString()
  });
});

// ====================== AUTH ROUTES ======================

// REGISTER
app.post('/auth/register',
  body('username').trim().isLength({ min: 3 }).escape(),
  body('password')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/)
    .withMessage('Password must contain uppercase, lowercase, number, and symbol'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, password, role = "USER" } = req.body;

    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(409).json({ error: "Username already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      username,
      password: hashedPassword,
      role: role.toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER'
    });

    res.status(201).json({ message: "User registered successfully", user: { username: newUser.username, role: newUser.role } });
  });

// LOGIN
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { id: user._id.toString(), username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );
  res.json({ token, user: { username: user.username, role: user.role } });
});

// ====================== TASK ROUTES ======================
app.get('/tasks', authenticateJWT, async (req, res) => {
  const cacheKey = `tasks:user:${req.user.id}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  const userTasks = await Task.find({ userId: req.user.id }).sort({ createdAt: -1 });
  await setCache(cacheKey, userTasks);
  res.json(userTasks);
});

app.post('/tasks', authenticateJWT, authorize(['USER', 'ADMIN']),
  body('title').trim().isLength({ min: 3 }).escape(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const task = new Task({ title: req.body.title, userId: req.user.id });
    await task.save();
    await invalidateCache(`tasks:user:${req.user.id}`);
    res.status(201).json(task);
  });

app.put('/tasks/:id', authenticateJWT, authorize(['USER', 'ADMIN']),
  body('title').trim().isLength({ min: 3 }).escape(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const task = await Task.findOne({ _id: req.params.id, userId: req.user.id });
    if (!task) return res.status(404).json({ error: "Task not found" });

    task.title = req.body.title;
    await task.save();
    await invalidateCache(`tasks:user:${req.user.id}`);
    res.json(task);
  });

app.delete('/tasks/:id', authenticateJWT, authorize(['USER', 'ADMIN']),
  async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, userId: req.user.id });
    if (!task) return res.status(404).json({ error: "Task not found" });

    await Task.deleteOne({ _id: req.params.id });
    await invalidateCache(`tasks:user:${req.user.id}`);
    res.json({ message: "Task deleted" });
  });

// ====================== METRICS ======================
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

app.listen(process.env.PORT || 3001, () => {
  logger.info(`✅ Task Service running on port ${process.env.PORT || 3001}`);
});