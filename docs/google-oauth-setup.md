# Setting Up Google OAuth

## Why it wasn't working (fixed)

The original code called `res.redirect(FRONTEND_URL + '/?token=...')` from inside the Docker service
container. When proxied through `http-proxy-middleware`, the 302 redirect Location header contained
an internal hostname or wrong port, and the browser ended up on the wrong URL.

**Fix applied:** the OAuth callback now serves a tiny HTML page that writes the JWT directly into
`localStorage` and navigates to the frontend using `window.location.replace()`. This runs in the
browser — no proxy issues, no hostname confusion.

---

## Step-by-step setup

### 1. Create a Google OAuth 2.0 credential

1. Go to **https://console.cloud.google.com/**
2. Select or create a project
3. Navigate to **APIs & Services → Credentials**
4. Click **Create Credentials → OAuth client ID**
5. Application type: **Web application**
6. Name: `Tasken (dev)`

### 2. Set Authorised redirect URIs

Add this URI exactly (for local dev):

```
http://localhost:8080/api/auth/oauth/google/callback
```

If deploying to a domain (e.g. `https://tasken.example.com`):

```
https://tasken.example.com/api/auth/oauth/google/callback
```

> **Note:** The callback must hit the **API Gateway** port (8080 in local dev),
> not the frontend port (3000). The gateway proxies it to the service.

### 3. Copy credentials into .env

```env
GOOGLE_CLIENT_ID=123456789-abcdef.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxx
GOOGLE_CALLBACK_URL=http://localhost:8080/api/auth/oauth/google/callback
FRONTEND_URL=http://localhost:3000
```

`FRONTEND_URL` must be what the **browser** uses to reach the frontend — not the Docker internal hostname.

### 4. Restart

```bash
docker compose down && docker compose up --build
```

### 5. Test

1. Open http://localhost:3000
2. Click **Continue with Google**
3. Complete Google sign-in
4. You are redirected back to http://localhost:3000 and automatically logged in

---

## How the fixed flow works

```
Browser
  │ GET /api/auth/oauth/google
  ▼
nginx (port 3000) → gateway (port 8080)
  │ Gateway: PUBLIC route, proxy to service
  ▼
service: passport redirects → Google

Google authenticates user
  │ GET http://localhost:8080/api/auth/oauth/google/callback?code=...
  ▼
Gateway → service: passport verifies code, gets user profile
  │ service: signs JWT, returns HTML page:
  │   localStorage.setItem('token', '<JWT>')
  │   window.location.replace('http://localhost:3000/?oauth=1')
  ▼
Browser runs the HTML, writes token to localStorage
  │ Navigates to http://localhost:3000/?oauth=1
  ▼
React: useEffect reads ?oauth=1, picks up token from localStorage
  → User is now logged in
```
