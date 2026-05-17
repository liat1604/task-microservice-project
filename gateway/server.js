const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();

// CORS
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));

// Public routes (no authentication required)
const publicRoutes = ['/auth/login', '/auth/register', '/auth/oauth', '/health', '/metrics'];

const authenticate = (req, res, next) => {
  // Skip auth for public routes
  if (publicRoutes.some(route => req.path.startsWith(route))) {
    return next();
  }

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(403).json({ error: "Invalid token" });
  }
};

// Proxy to microservice
app.use('/api', authenticate, createProxyMiddleware({
  target: 'http://service:3001',
  changeOrigin: true,
  pathRewrite: { '^/api': '' }
}));

app.get('/health', (req, res) => res.json({ status: 'Gateway healthy' }));

app.listen(3000, () => console.log('✅ API Gateway running on port 3000'));