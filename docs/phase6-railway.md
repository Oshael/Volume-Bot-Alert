# Phase 6 - Deploy target: Railway (quick path)

## 1) Architecture on Railway
- Service A: `volume-alert-server` (Node/Express + Socket.io)
- Service B: PostgreSQL (Railway managed Postgres)
- Frontend: static site hosted on a real domain (Vercel used in production validation)
- Current supported runtime topology: `1 replica only`

## 2) Create Railway project
1. Create a new Railway project.
2. Add PostgreSQL plugin/service.
3. Add your GitHub repo and select the backend service root.

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
- Optional explicit SSL flags when needed:
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
Run the base init required by the project.

Important:
- Production user config persistence also depends on the Stage 4 tables.
- If those tables are missing, `GET /api/config` will fail even when auth and health checks are green.
- Required Stage 4 tables:
  - `user_configs`
  - `user_tokens`
  - `user_blocklist`

If local execution against Railway Postgres is necessary:
- use the Postgres public connection URL;
- enable SSL;
- do not rely on `postgres.railway.internal` from your local shell.

## 6) Frontend integration in production
- Set frontend API base to Railway app URL, or ensure the frontend falls back to Railway when hosted elsewhere.
- Ensure browser origin is included in `CORS_ORIGINS`.
- Validate login -> `/api/auth/me` -> socket connect -> config sync.
- For temporary local HTML tests, add `http://localhost:8080` to `CORS_ORIGINS` and remove it when done.

## 7) Validated production checks
Already validated in the current production setup:
- health endpoint
- login
- socket auth/connect
- config persistence per account
- same account in multiple sessions
- `logout-all`
- Vercel frontend talking to Railway backend

## 8) Remaining go-live follow-up
- Re-run `security-check.ps1` after the latest deploys.
- Keep Railway at a single replica until realtime state is made multi-instance-safe.
- Before migrating the newer HTML, compare its config contract against the backend `/api/config` schema.
