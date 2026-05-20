/**
 * API Gateway — sole entry point for all clients.
 *
 * Google OAuth is handled HERE in the gateway (not proxied to the service).
 * WHY: The callback URL hits port 8080 directly from the browser. Doing OAuth
 * here lets us res.redirect() straight to localhost:3000 — no proxy chain,
 * no CSP inline-script blocks, no internal Docker hostname confusion.
 *
 * Security patterns: Gateway, Authenticator, OAuth Client, Proxy, Rate Limiter
 */

const express   = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt       = require('jsonwebtoken');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const passport  = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const session   = require('express-session');
const axios     = require('axios');
const winston   = require('winston');
const promClient = require('prom-client');
require('dotenv').config();

const app = express();

const SERVICE_URL  = process.env.SERVICE_URL  || 'http://service:3001';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

// ====================== LOGGER ======================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'gateway-error.log',    level: 'error' }),
    new winston.transports.File({ filename: 'gateway-combined.log' })
  ]
});

// ====================== PROMETHEUS ======================
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestsTotal = new promClient.Counter({
  name: 'gateway_requests_total', help: 'Total HTTP requests through the gateway',
  labelNames: ['method', 'route', 'status'], registers: [register]
});
const httpRequestDuration = new promClient.Histogram({
  name: 'gateway_request_duration_ms', help: 'Request latency ms',
  labelNames: ['method', 'route', 'status'],
  buckets: [50, 100, 250, 500, 1000, 2500], registers: [register]
});

// ====================== IN-MEMORY METRICS STORE ======================
const metricsStore = { startedAt: Date.now(), buckets: new Map(), recent: [] };
function recordMetric(method, path, status, durationMs) {
  const route = path.replace(/\/[0-9a-f]{24}/gi, '/:id').replace(/\/[0-9a-f-]{36}/gi, '/:id');
  const key = `${method}|${route}|${status}`;
  let b = metricsStore.buckets.get(key);
  if (!b) { b = { count: 0, sumMs: 0 }; metricsStore.buckets.set(key, b); }
  b.count++; b.sumMs += durationMs;
  const now = Date.now();
  metricsStore.recent.push({ t: now, err: status >= 400 });
  const cutoff = now - 60000;
  while (metricsStore.recent.length && metricsStore.recent[0].t < cutoff) metricsStore.recent.shift();
}
function getMetricsSnapshot() {
  const total  = Array.from(metricsStore.buckets.values()).reduce((a, b) => a + b.count, 0);
  const errors = Array.from(metricsStore.buckets.entries())
    .filter(([k]) => Number(k.split('|')[2]) >= 400).reduce((a, [, b]) => a + b.count, 0);
  const perRoute = Array.from(metricsStore.buckets.entries()).map(([k, b]) => {
    const [method, route, status] = k.split('|');
    return { method, route, status: Number(status), count: b.count, avgMs: Math.round(b.sumMs / b.count) };
  });
  return {
    uptimeSec: Math.round((Date.now() - metricsStore.startedAt) / 1000),
    totalRequests: total, totalErrors: errors,
    errorRate: total ? +(errors / total).toFixed(4) : 0,
    last60s: { requests: metricsStore.recent.length, errors: metricsStore.recent.filter(r => r.err).length, rps: +(metricsStore.recent.length / 60).toFixed(2) },
    perRoute: perRoute.sort((a, b) => b.count - a.count).slice(0, 50)
  };
}

// ====================== SECURE HEADERS ======================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com']
    }
  },
  hsts:           { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'no-referrer' }
}));

// ====================== CORS ======================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ====================== RATE LIMITING ======================
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/login',    rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }));

// ====================== SESSION (passport OAuth state only) ======================
app.use(session({
  secret: process.env.JWT_SECRET || 'session-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 10 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((u, done) => done(null, u));

// ====================== GOOGLE OAUTH ======================
const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (googleEnabled) {
  const callbackURL = process.env.GOOGLE_CALLBACK_URL ||
    `${process.env.API_GATEWAY_URL || 'http://localhost:8080'}/api/auth/oauth/google/callback`;

  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID.trim(),
      clientSecret: process.env.GOOGLE_CLIENT_SECRET.trim(),
      callbackURL
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  ));

  // Step 1: send user to Google
  app.get('/api/auth/oauth/google',
    passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })
  );

  // Step 2: Google sends user back here
  app.get('/api/auth/oauth/google/callback',
    passport.authenticate('google', {
      failureRedirect: `${FRONTEND_URL}/?error=oauth_failed`,
      session: true
    }),
    async (req, res) => {
      try {
        const profile  = req.user;
        const googleId = profile.id;
        const email    = profile.emails?.[0]?.value;

        // Call the service to create/fetch the user record
        const { data } = await axios.post(
          `${SERVICE_URL}/auth/oauth/upsert`,
          { googleId, email },
          { timeout: 5000, headers: { 'x-internal-secret': process.env.JWT_SECRET } }
        );

        const token = jwt.sign(
          { id: data.id, username: data.username, role: data.role },
          process.env.JWT_SECRET,
          { expiresIn: '2h', issuer: 'task-gateway' }
        );

        logger.info('oauth_login_success', { username: data.username });

        // Simple redirect — browser follows, frontend reads ?token= and stores it
        res.redirect(`${FRONTEND_URL}/?token=${encodeURIComponent(token)}`);
      } catch (err) {
        logger.error('oauth_upsert_failed', { error: err.message });
        res.redirect(`${FRONTEND_URL}/?error=oauth_failed`);
      }
    }
  );

  logger.info('Google OAuth enabled');
} else {
  app.get('/api/auth/oauth/google', (req, res) =>
    res.status(503).json({ error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env' })
  );
  app.get('/api/auth/oauth/google/callback', (req, res) =>
    res.redirect(`${FRONTEND_URL}/?error=oauth_failed`)
  );
  logger.warn('Google OAuth disabled — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set');
}

// OAuth capability check — called by frontend to decide whether to show the Google button
app.get('/api/auth/oauth/status', (req, res) => {
  res.json({ googleOAuth: googleEnabled });
});

// ====================== REQUEST LOGGING + METRICS ======================
app.use((req, res, next) => {
  const start = Date.now();
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  req.reqId = reqId;
  res.on('finish', () => {
    const duration = Date.now() - start;
    const route    = req.path.replace(/\/[0-9a-f]{24,36}/gi, '/:id');
    logger.info('request', { reqId, method: req.method, path: req.path, status: res.statusCode, durationMs: duration, ip: req.ip });
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route, status: res.statusCode }, duration);
    recordMetric(req.method, req.path, res.statusCode, duration);
  });
  next();
});

// ====================== JWT AUTHENTICATION ======================
const PUBLIC_PREFIXES = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/forgot-username',
  '/api/auth/oauth',
  '/api/health',
  '/health',
  '/metrics'
];

const authenticate = (req, res, next) => {
  if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn('auth_missing', { path: req.path, ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized: missing token' });
  }

  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.user = decoded;
    req.headers['x-user-id']   = decoded.id;
    req.headers['x-user-role'] = decoded.role;
    req.headers['x-user-name'] = decoded.username;
    next();
  } catch (err) {
    logger.warn('auth_failed', { path: req.path, error: err.message });
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(403).json({ error: 'Invalid token' });
  }
};

app.use(authenticate);

// ====================== ADMIN METRICS JSON ======================
app.get('/api/metrics-json', (req, res) => {
  if (!req.user || req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin role required' });
  res.json(getMetricsSnapshot());
});

// ====================== PROXY ======================
app.use('/api', createProxyMiddleware({
  target:       SERVICE_URL,
  changeOrigin: true,
  pathRewrite:  { '^/api': '' },
  on: {
    error: (err, req, res) => {
      logger.error('proxy_error', { error: err.message, path: req.path });
      res.status(502).json({ error: 'Service temporarily unavailable' });
    }
  }
}));

// ====================== HEALTH + PROMETHEUS ======================
app.get('/health', (req, res) =>
  res.json({ status: 'healthy', service: 'api-gateway', timestamp: new Date().toISOString(), googleOAuth: googleEnabled })
);

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ====================== 404 + ERROR ======================
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  logger.error('unhandled_error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`API Gateway running on port ${PORT}`));
