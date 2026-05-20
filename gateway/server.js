/**
 * API Gateway — sole entry point for all clients.
 * Security pipeline per request:
 *   1. Secure HTTP headers (helmet)
 *   2. CORS
 *   3. Rate limiting (per-IP, stricter on auth routes)
 *   4. JWT authentication
 *   5. Request logging + Prometheus metrics
 *   6. Proxy to internal task microservice
 *
 * Implements the Gateway, Authenticator, and Proxy security patterns.
 */

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const promClient = require('prom-client');
require('dotenv').config();

const app = express();

// ====================== LOGGER ======================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'gateway-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'gateway-combined.log' })
  ]
});

// ====================== PROMETHEUS ======================
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestsTotal = new promClient.Counter({
  name: 'gateway_requests_total',
  help: 'Total HTTP requests through the gateway',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});

const httpRequestDuration = new promClient.Histogram({
  name: 'gateway_request_duration_ms',
  help: 'Request latency in milliseconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [50, 100, 250, 500, 1000, 2500],
  registers: [register]
});

// ====================== IN-MEMORY METRICS STORE (admin dashboard) ======================
const metricsStore = {
  startedAt: Date.now(),
  buckets: new Map(),
  recent: []
};

function recordMetric(method, path, status, durationMs) {
  const route = path.replace(/\/[0-9a-f]{24}/gi, '/:id').replace(/\/[0-9a-f-]{36}/gi, '/:id');
  const key = `${method}|${route}|${status}`;
  let b = metricsStore.buckets.get(key);
  if (!b) { b = { count: 0, sumMs: 0 }; metricsStore.buckets.set(key, b); }
  b.count++;
  b.sumMs += durationMs;
  const now = Date.now();
  metricsStore.recent.push({ t: now, err: status >= 400 });
  const cutoff = now - 60000;
  while (metricsStore.recent.length && metricsStore.recent[0].t < cutoff) metricsStore.recent.shift();
}

function getMetricsSnapshot() {
  const total = Array.from(metricsStore.buckets.values()).reduce((a, b) => a + b.count, 0);
  const errors = Array.from(metricsStore.buckets.entries())
    .filter(([k]) => Number(k.split('|')[2]) >= 400)
    .reduce((a, [, b]) => a + b.count, 0);
  const perRoute = Array.from(metricsStore.buckets.entries()).map(([k, b]) => {
    const [method, route, status] = k.split('|');
    return { method, route, status: Number(status), count: b.count, avgMs: Math.round(b.sumMs / b.count) };
  });
  return {
    uptimeSec: Math.round((Date.now() - metricsStore.startedAt) / 1000),
    totalRequests: total, totalErrors: errors,
    errorRate: total ? +(errors / total).toFixed(4) : 0,
    last60s: {
      requests: metricsStore.recent.length,
      errors: metricsStore.recent.filter(r => r.err).length,
      rps: +(metricsStore.recent.length / 60).toFixed(2)
    },
    perRoute: perRoute.sort((a, b) => b.count - a.count).slice(0, 50)
  };
}

// ====================== SECURE HEADERS (helmet) ======================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'no-referrer' }
}));

// ====================== CORS ======================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
app.use(cors({
  origin: (origin, callback) => {
    // Allow same-origin / no-origin (e.g. server-to-server health checks)
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ====================== RATE LIMITING ======================
// Global limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Strict limiter for auth endpoints to stop brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' }
});

app.use(globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ====================== REQUEST LOGGING + METRICS ======================
app.use((req, res, next) => {
  const start = Date.now();
  const reqId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  req.reqId = reqId;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = req.route?.path || req.path.replace(/\/[0-9a-f-]{24,36}/gi, '/:id');

    logger.info('request', {
      reqId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip,
      user: req.user?.username || 'anonymous'
    });

    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route, status: res.statusCode }, duration);
    recordMetric(req.method, req.path, res.statusCode, duration);
  });
  next();
});

// ====================== JWT AUTHENTICATION ======================
const PUBLIC_ROUTES = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/oauth',
  '/health',
  '/metrics'
];

const authenticate = (req, res, next) => {
  if (PUBLIC_ROUTES.some(route => req.path.startsWith(route))) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('auth_missing', { reqId: req.reqId, path: req.path, ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized: missing token' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    // Forward user info to upstream service
    req.headers['x-user-id'] = decoded.id;
    req.headers['x-user-role'] = decoded.role;
    req.headers['x-user-name'] = decoded.username;
    next();
  } catch (err) {
    logger.warn('auth_failed', { reqId: req.reqId, path: req.path, ip: req.ip, error: err.message });
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired, please log in again' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
};

app.use(authenticate);

// ====================== PROXY ======================
app.use('/api', createProxyMiddleware({
  target: process.env.SERVICE_URL || 'http://service:3001',
  changeOrigin: true,
  pathRewrite: { '^/api': '' },
  on: {
    error: (err, req, res) => {
      logger.error('proxy_error', { error: err.message, path: req.path });
      res.status(502).json({ error: 'Service temporarily unavailable' });
    }
  }
}));

// ====================== HEALTH + METRICS ======================
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'api-gateway', timestamp: new Date().toISOString() });
});

// Admin-only JSON metrics for the dashboard
app.get('/api/metrics-json', (req, res) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin role required to view metrics' });
  }
  res.json(getMetricsSnapshot());
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ====================== 404 FALLBACK ======================
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ====================== ERROR HANDLER ======================
app.use((err, req, res, _next) => {
  logger.error('unhandled_error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`✅ API Gateway running on port ${PORT}`));
