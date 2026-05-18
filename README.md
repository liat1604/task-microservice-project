# Tasken — Task Manager Microservice

A secure task-management microservice with React frontend, API Gateway, and Task Service backed by MongoDB and Redis.

---

## Quick Start

```bash
# 1. Copy and configure environment
cp .env.example .env
# Edit .env — at minimum set a strong JWT_SECRET

# 2. Build and run
docker compose up --build

# 3. Open in browser
open http://localhost:3000
```

Default admin account (created automatically on first run):
- **Username:** `admin`
- **Password:** `Admin@1234!`

---

## Architecture

```
Browser (port 3000)
    │
    ▼
Frontend — React + nginx (port 3000)
    │  /api/* → proxied to gateway
    ▼
API Gateway (port 8080 external / 3000 internal)
    │  JWT auth, rate limiting, logging, Prometheus metrics
    ▼
Task Service (port 3001 — internal only, not exposed)
    │  Business logic, RBAC, input validation, Redis caching
    ├──▶ MongoDB — persistent task/user storage
    └──▶ Redis — response caching + token invalidation
```

All access to the Task Service goes through the API Gateway. MongoDB and Redis are not exposed externally.

---

## Bugs Fixed (vs. original)

| # | Bug | Fix |
|---|-----|-----|
| 1 | `nginx.conf` was proxying `/api/` to `http://gateway:3000/` (stripped the `/api` prefix before gateway expected it) | Fixed: proxy now sends to `http://gateway:3000/api/` so the gateway's `authenticate` middleware correctly matches routes |
| 2 | Gateway `server.js` had no `helmet` secure headers | Added `helmet` with CSP, HSTS, referrer-policy |
| 3 | Gateway `package.json` missing `express-rate-limit`, `helmet`, `prom-client`, `winston` dependencies | Added all missing dependencies |
| 4 | Service had no `helmet` | Added `helmet` |
| 5 | Login had timing-attack vulnerability (short-circuit on missing user before bcrypt) | Fixed with constant-time comparison pattern |
| 6 | Gateway metrics endpoint (`/metrics`) had no Prometheus registry — `register` was never defined | Gateway now creates its own `promClient.Registry()` and collects default metrics |
| 7 | Service `httpRequestsTotal` counter was defined but `httpRequestDuration` histogram was never created | Added histogram to service |
| 8 | `param('id').isMongoId()` validation was missing on DELETE and PUT — invalid IDs caused Mongoose cast errors | Added `param` validation on all ID-bearing routes |
| 9 | No `body({ limit: '50kb' })` — service was vulnerable to large-body DoS | Added `express.json({ limit: '50kb' })` |
| 10 | `ALLOWED_ORIGINS` env var was hardcoded in gateway CORS; multiple origins unsupported | Gateway now reads `process.env.ALLOWED_ORIGINS` (comma-separated) |

---

## Features

### Security (Requirement 2.3–2.6 + 2.8)
- **JWT authentication** — short-lived 2h tokens, signed with HS256
- **bcrypt password hashing** — cost factor 12
- **RBAC authorization** — `USER` and `ADMIN` roles enforced on every protected route
- **Google OAuth 2.0** — delegated authentication via Passport.js
- **Rate limiting** — global (300 req/15min) + strict auth limiter (20 req/15min)
- **Input validation + sanitization** — `express-validator` on all inputs, body size limit
- **Secure HTTP headers** — `helmet` (CSP, HSTS, X-Content-Type-Options, Referrer-Policy)
- **Redis token/cache invalidation** — cache invalidated on every write
- **Network isolation** — MongoDB and Redis not exposed externally; service not exposed externally

### Logging & Monitoring (Requirement 2.5)
- **Winston** structured JSON logging in both gateway and service
- **Prometheus metrics** exposed at `/metrics` (scrape-ready)
  - `gateway_requests_total` — counter by method/route/status
  - `gateway_request_duration_ms` — histogram with latency buckets
  - `http_requests_total`, `http_request_duration_ms` — same on service
  - `active_tasks_total` — gauge updated on create/delete
- **Admin metrics dashboard** — live JSON metrics at `/api/metrics-json` (admin-only), with 5s auto-refresh, per-route table, error rate, uptime, and req/s

### Task Features (Requirement 2.1 + 2.7)
- Create, read, update, delete tasks
- Status: `todo` → `in_progress` → `done` (one-click cycle)
- Priority: `low`, `medium`, `high`
- Tags with multi-tag filtering
- Description field
- Redis cache-aside (5-min TTL, invalidated on write)

---

## API Reference

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | Public | Register new user |
| POST | `/api/auth/login` | Public | Login, receive JWT |
| GET | `/api/auth/oauth/google` | Public | Start Google OAuth |

### Tasks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/tasks` | JWT | List current user's tasks |
| POST | `/api/tasks` | JWT | Create task |
| PUT | `/api/tasks/:id` | JWT | Update task |
| DELETE | `/api/tasks/:id` | JWT | Delete task |

### Admin (role: ADMIN required)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/tasks` | JWT+ADMIN | All tasks |
| GET | `/api/admin/users` | JWT+ADMIN | All users |

### Observability
| Path | Description |
|------|-------------|
| `/health` | Gateway health check |
| `/metrics` | Prometheus exposition (gateway) |
| `/api/metrics` | Prometheus exposition (service) |
| `/api/metrics-json` | JSON snapshot for admin dashboard (ADMIN only) |
