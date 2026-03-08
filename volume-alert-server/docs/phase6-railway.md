# Phase 6 - Deploy target: Railway (quick path)

## 1) Architecture on Railway
- Service A: `volume-alert-server` (Node/Express + Socket.io)
- Service B: PostgreSQL (Railway managed Postgres)
- Frontend can stay static (`file://`) for now, but production should be hosted on a real domain (Vercel/Netlify/Cloudflare Pages).

## 2) Create Railway project
1. Create a new Railway project.
2. Add PostgreSQL plugin/service.
3. Add your GitHub repo and select `volume-alert-server` folder as root service.

## 3) Required environment variables (Server service)
Set these in Railway Variables:

- `NODE_ENV=production`
- `PORT=3000`
- `JWT_SECRET=<strong-random-64+ chars>`
- `FORCE_HTTPS=true`
- `CORS_ORIGINS=https://<your-frontend-domain>`

Database:
- Prefer single URL from Railway Postgres:
  - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- Optional explicit SSL flags (usually not needed when URL already has SSL params):
  - `DB_SSL=true`
  - `DB_SSL_REJECT_UNAUTHORIZED=false`

Rate limits and auth limits (optional, defaults exist):
- `RATE_LIMIT_WINDOW_MS=900000`
- `RATE_LIMIT_MAX_REQUESTS=100`
- `AUTH_RATE_LIMIT_WINDOW_MS=900000`
- `AUTH_RATE_LIMIT_MAX_REQUESTS=10`

## 4) First deploy and smoke test
1. Deploy the service on Railway.
2. Open generated Railway URL and hit:
   - `GET /api/health`
3. Confirm server logs show startup without DB/auth errors.

## 5) Database initialization
After deploy, run once in Railway service shell:

```bash
npm run db:init
```

(Optional) create bootstrap invite:

```bash
npm run invite:create
```

## 6) Frontend integration in production
- Set frontend API base to Railway app URL (or custom domain API URL).
- Ensure browser origin is included in `CORS_ORIGINS`.
- Validate login -> `/api/auth/me` -> socket connect -> config sync.

## 7) Security checks on Railway
Run local battery against deployed URL:

```powershell
./security-check.ps1 -BaseUrl "https://<your-railway-domain>"
```

Expected:
- no critical FAIL
- WARN only if known non-blocking items

## 8) Go-live checklist (minimum)
- HTTPS only (`FORCE_HTTPS=true`)
- strict `CORS_ORIGINS` (no localhost in production)
- JWT secret rotated from dev value
- `/api/health` green
- login + websocket + logout-all validated
- backup policy for Postgres enabled
