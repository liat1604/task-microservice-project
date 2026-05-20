# Tasken — Secure Task Management Microservice

A production-grade task management application built as a microservice architecture with a focus on security. Features JWT authentication, Google OAuth 2.0, role-based access control, real-time collaboration, Prometheus monitoring, and structured audit logging — all running behind a dedicated API Gateway.

---

## Table of Contents

- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Security Implementation](#security-implementation)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Default Credentials](#default-credentials)
- [Project Structure](#project-structure)
- [Security Patterns Applied](#security-patterns-applied)

---

## Architecture

```
Browser (port 3000)
        │
        ▼
┌─────────────────────┐
│   React Frontend    │  nginx reverse proxy
│   (port 3000)       │
└──────────┬──────────┘
           │  /api/* proxied
           ▼
┌─────────────────────┐
│    API Gateway      │  JWT auth · Rate limiting
│    (port 8080)      │  Helmet headers · CORS
│                     │  Prometheus metrics
│                     │  Google OAuth handler
└──────────┬──────────┘
           │  Internal network only
           ▼
┌─────────────────────┐
│   Task Microservice │  Business logic · RBAC
│   (port 3001)       │  Input validation
│   (not exposed)     │  Winston logging · Audit log
└────────┬───┬────────┘
         │   │
         ▼   ▼
   MongoDB   Redis
  (tasks,   (cache,
   users,    sessions)
   audit)
```

All services run in isolated Docker networks. MongoDB and Redis are never exposed externally. The task microservice has no public port — every request must go through the API Gateway.

---

## Tech Stack

### Backend
| Layer | Technology | Purpose |
|---|---|---|
| Language | Node.js 20 | Runtime |
| Framework | Express.js 4 | HTTP server |
| Database | MongoDB 7 + Mongoose 8 | Persistent storage |
| Cache | Redis 7 | Response caching, session invalidation |
| Auth | jsonwebtoken + bcryptjs | JWT issuance, password hashing |
| OAuth | Passport.js + passport-google-oauth20 | Google OAuth 2.0 |
| Validation | express-validator | Input sanitization and validation |
| Rate Limiting | express-rate-limit | DDoS/brute-force protection |
| Security Headers | helmet | CSP, HSTS, X-Content-Type-Options |
| Logging | winston | Structured JSON logging |
| Monitoring | prom-client | Prometheus metrics exposition |
| Email | nodemailer | Password recovery emails |
| Gateway Proxy | http-proxy-middleware | Request forwarding |

### Frontend
| Technology | Purpose |
|---|---|
| React 18 | UI framework |
| Axios | HTTP client |
| nginx | Static file serving + reverse proxy |

### Infrastructure
| Technology | Purpose |
|---|---|
| Docker + Docker Compose | Containerisation and orchestration |
| nginx (Alpine) | Frontend serving + API proxying |
| Node 20 Alpine | Minimal production containers |

---

## Security Implementation

### Authentication
- **JWT** — short-lived 2-hour access tokens signed with HS256
- **bcrypt** — passwords hashed at cost factor 12, never stored in plaintext
- **Google OAuth 2.0** — delegated authentication via Passport.js, handled entirely at the gateway layer to avoid proxy chain issues
- **Timing-safe login** — constant-time bcrypt comparison prevents username enumeration via timing attacks

### Authorization
- **RBAC** — `ADMIN` and `USER` roles enforced by middleware on every protected route
- **Fine-grained sharing** — tasks can be shared with `read` (Viewer) or `edit` (Editor) permission per collaborator, enforced server-side
- **Least privilege** — the task microservice is not exposed externally; internal service-to-service calls use a shared secret header

### Transport & Headers
- **HTTPS-ready** — HSTS header enforced
- **Helmet** — Content Security Policy, X-Content-Type-Options, Referrer-Policy
- **CORS** — explicit allowlist of permitted origins
- **Body size limit** — `express.json({ limit: '100kb' })` prevents large-body DoS

### Input Security
- All user inputs validated and sanitized with express-validator (`.trim()`, `.escape()`, `.isMongoId()`, `.isEmail()`)
- MongoDB object IDs validated before any database operation
- CSV export escapes formula injection characters (`=`, `+`, `-`, `@`)
- Tags sanitized through a dedicated `sanitizeTags()` function

### Rate Limiting
| Endpoint group | Window | Max requests |
|---|---|---|
| All routes (global) | 15 minutes | 300 |
| `/auth/login` | 15 minutes | 20 |
| `/auth/register` | 15 minutes | 20 |
| `/auth/forgot-*` | 15 minutes | 20 |

### Audit Trail
Every create, update, delete, share, export, and import action is written to a persistent MongoDB `Audit` collection with: `userId`, `username`, `action`, `resourceId`, `detail`, `ip`, `timestamp`. Viewable in the frontend Activity Log tab and via the admin endpoint.

---

## Features

### Task Management
- Create, read, update, delete tasks
- Status lifecycle: `Todo → In Progress → Done` (one-click cycle)
- Priority levels: Low, Medium, High
- Tags with multi-tag filtering
- Due dates with overdue/upcoming notifications
- Recurring tasks (daily / weekly / monthly)
- Subtasks with inline tick-off (no modal required)
- Drag-and-drop priority reordering

### Collaboration
- Share tasks with specific users by username or email
- Two permission levels: **Viewer** (read-only) and **Editor** (can update)
- Owners can promote/demote collaborators without removing access
- Shared tasks appear in a dedicated **Collaborations** tab
- Tasks automatically move between tabs when editors are added/removed
- Live activity feed polling every 8 seconds shows real-time collaborator edits
- `lastEditedBy` attribution on every shared task

### Account Management
- Email + username login (either accepted in one field)
- Password strength meter with real-time rule checking
- Confirm password with match indicator
- Forgot password — sends a temporary password via email
- Forgot username — sends username to registered email
- Change password (requires current password verification)
- Delete account (requires password confirmation, cascades deletes)

### Notifications
- In-app notification bell with unread badge count
- Notified when: task shared with you, access removed, collaborator completes/edits a task
- Mark individual or all notifications as read
- Dismiss notifications

### Import / Export
- Export all tasks as JSON or CSV
- Import tasks from JSON or CSV
- CSV export is injection-safe

### Admin
- Admin metrics dashboard with live request rate, error rate, latency, and per-route breakdown
- View all users and all tasks
- Full audit log across all users
- Prometheus `/metrics` endpoint for external scraping

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)
- A Google account (optional — for Google OAuth)
- A Gmail App Password (optional — for email features)

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-username/tasken.git
cd tasken
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in the required values. At minimum, set a strong `JWT_SECRET`. See [Environment Variables](#environment-variables) for the full reference.

### 3. Build and start

```bash
docker compose up --build
```

First run takes 2–3 minutes to pull images and install dependencies. Subsequent starts are faster.

### 4. Open the app

```
http://localhost:3000
```

### Stopping

```bash
docker compose down          # stop containers, keep data
docker compose down --volumes  # stop containers and wipe all data
```

### Viewing logs

```bash
docker compose logs service    # task microservice logs
docker compose logs gateway    # API gateway logs
docker compose logs -f         # follow all logs
```

### Checking email configuration

```bash
docker compose logs service | grep email
# ✅ Good:  [email] ✅ SMTP ready — you@gmail.com via smtp.gmail.com:587
# ❌ Bad:   [email] ❌ SMTP connection FAILED: Invalid login
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values. **Never commit `.env` to version control** — it is listed in `.gitignore`.

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Long random string for signing JWTs. Generate with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `MONGO_URL` | ✅ | MongoDB connection string (default works with Docker Compose) |
| `REDIS_URL` | ✅ | Redis connection string (default works with Docker Compose) |
| `SERVICE_URL` | ✅ | Internal URL of the task service (default works with Docker Compose) |
| `FRONTEND_URL` | ✅ | Browser-facing URL of the frontend e.g. `http://localhost:3000` |
| `ALLOWED_ORIGINS` | ✅ | Comma-separated CORS allowed origins |
| `API_GATEWAY_URL` | ✅ | Browser-facing URL of the gateway e.g. `http://localhost:8080` |
| `SMTP_HOST` | Optional | SMTP server e.g. `smtp.gmail.com` |
| `SMTP_PORT` | Optional | SMTP port e.g. `587` |
| `SMTP_USER` | Optional | SMTP username / Gmail address |
| `SMTP_PASS` | Optional | Gmail App Password (not your regular password) |
| `SMTP_FROM` | Optional | From address e.g. `Tasken <you@gmail.com>` |
| `GOOGLE_CLIENT_ID` | Optional | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Optional | Google OAuth client secret |
| `GOOGLE_CALLBACK_URL` | Optional | Must be `http://localhost:8080/api/auth/oauth/google/callback` in dev |

### Setting up Gmail (for email features)

1. Enable **2-Step Verification** on your Google account
2. Go to **myaccount.google.com/apppasswords**
3. Generate a new App Password named "Tasken"
4. Copy the 16-character password into `SMTP_PASS`

### Setting up Google OAuth

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **Credentials → Create OAuth client ID → Web application**
2. Add authorised redirect URI: `http://localhost:8080/api/auth/oauth/google/callback`
3. Copy the client ID and secret into `.env`

See `docs/google-oauth-setup.md` for the full guide.

---

## API Reference

All routes are accessed through the API Gateway at `http://localhost:8080/api/...` or via the frontend at `http://localhost:3000/api/...`.

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | Public | Register new user |
| `POST` | `/api/auth/login` | Public | Login with username or email |
| `POST` | `/api/auth/forgot-password` | Public | Email temporary password |
| `POST` | `/api/auth/forgot-username` | Public | Email username |
| `PATCH` | `/api/auth/password` | JWT | Change password |
| `DELETE` | `/api/auth/account` | JWT | Delete account |
| `GET` | `/api/auth/oauth/google` | Public | Start Google OAuth flow |
| `GET` | `/api/auth/oauth/status` | Public | Check if Google OAuth is configured |

### Tasks

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/tasks` | JWT | Get all own tasks |
| `POST` | `/api/tasks` | JWT | Create task |
| `PUT` | `/api/tasks/:id` | JWT | Update task (owner or editor) |
| `DELETE` | `/api/tasks/:id` | JWT | Delete task |
| `POST` | `/api/tasks/reorder` | JWT | Save drag-and-drop order |
| `GET` | `/api/tasks/shared` | JWT | Tasks shared with current user |
| `GET` | `/api/tasks/export/json` | JWT | Export tasks as JSON |
| `GET` | `/api/tasks/export/csv` | JWT | Export tasks as CSV |
| `POST` | `/api/tasks/import` | JWT | Import tasks from JSON/CSV |
| `PATCH` | `/api/tasks/:id/subtasks/:subId` | JWT | Toggle subtask completion |

### Sharing

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/tasks/:id/share` | JWT | Share task or update permission |
| `DELETE` | `/api/tasks/:id/share/:userId` | JWT | Remove collaborator / leave task |

### Notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/notifications` | JWT | Get all notifications |
| `PATCH` | `/api/notifications/read` | JWT | Mark notifications as read |
| `DELETE` | `/api/notifications/:id` | JWT | Dismiss notification |

### Users

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/users/search?q=` | JWT | Search users by username or email |

### Audit

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/audit` | JWT | Current user's audit log |
| `GET` | `/api/admin/audit` | Admin | All users' audit log |

### Admin

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/admin/tasks` | Admin | All tasks |
| `GET` | `/api/admin/users` | Admin | All users |
| `GET` | `/api/metrics-json` | Admin | Live metrics JSON for dashboard |

### Observability

| Path | Description |
|---|---|
| `/health` | Gateway health check |
| `/metrics` | Prometheus exposition (gateway, port 8080) |
| `/api/metrics` | Prometheus exposition (service, via gateway) |
| `/api/health` | Service health check (MongoDB + Redis status) |

---

## Default Credentials

| Account | Username | Password |
|---|---|---|
| Admin | `admin` | `Admin@1234!` |

The admin account is created automatically on first run if it does not exist. **Change this password before deploying to any public environment.**

---

## Project Structure

```
tasken/
├── gateway/                  # API Gateway
│   ├── server.js             # JWT auth, OAuth, rate limiting, proxy
│   ├── package.json
│   └── Dockerfile
│
├── service/                  # Task Microservice
│   ├── server.js             # Business logic, RBAC, validation, logging
│   ├── package.json
│   └── Dockerfile
│
├── frontend/                 # React SPA
│   ├── src/
│   │   ├── App.js            # Single-file React application
│   │   └── index.js
│   ├── public/index.html
│   ├── nginx.conf            # Reverse proxy config
│   ├── package.json
│   └── Dockerfile
│
├── docs/
│   └── google-oauth-setup.md
│
├── docker-compose.yml        # Service orchestration
├── .env.example              # Environment variable template
├── .gitignore                # Excludes .env, node_modules, logs
└── README.md
```

---

## Security Patterns Applied

| Pattern | Location | Description |
|---|---|---|
| **Gateway Pattern** | `gateway/server.js` | Single entry point hides internal service topology |
| **Authenticator Pattern** | Gateway + Service | JWT verification, bcrypt password hashing |
| **OAuth Client Pattern** | `gateway/server.js` | Delegated authentication via Google OAuth 2.0 |
| **RBAC Enforcer** | `service/server.js` | Role-based middleware on every protected route |
| **Input Validator** | `service/server.js` | express-validator on all inputs, body size limits |
| **Secure Logger** | Both services | Winston structured JSON logging, persistent audit trail |
| **Cache-Aside** | `service/server.js` | Redis cache with invalidation on every write |
| **Least Privilege** | `docker-compose.yml` | Service/DB not exposed externally, minimal network access |
| **Rate Limiter** | Both services | Per-IP limits on all routes, stricter on auth endpoints |

---

## Acknowledgements

Built with Node.js, Express, MongoDB, Redis, React, and Docker.
