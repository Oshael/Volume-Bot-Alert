# Phase 6 Runbook (Hardening + Deploy)

## 1. Production environment
- Set `NODE_ENV=production`.
- Set `FORCE_HTTPS=true`.
- Set strict `CORS_ORIGINS` to the real frontend domain(s) only.
- Use a strong `JWT_SECRET`.
- If you need to test the HTML locally with `python -m http.server 8080`, add `http://localhost:8080` to `CORS_ORIGINS` temporarily and remove it after testing.

## 2. Supported topology
- Current deployment model is `single replica only`.
- Do not scale the API horizontally yet.
- Reason: Socket.io session revocation and PumpFun subscription/refcount tracking are still process-local in memory.

## 3. Process management
- Run Node with restart policy (systemd/pm2/Railway managed restart).
- Keep app listening on `127.0.0.1:3000` behind reverse proxy, or use Railway public edge in hosted mode.

## 4. Reverse proxy and TLS
- Use `deploy/nginx/volume-alert-server.conf.example` as baseline when self-hosting.
- Issue TLS certificate (Let's Encrypt) when not relying on Railway edge TLS.
- Verify HTTP -> HTTPS redirect.

## 5. Database initialization
- Initial auth/session tables are created by Stage 1 init.
- Production config persistence also requires the Stage 4 tables:
  - `user_configs`
  - `user_tokens`
  - `user_blocklist`
- If `/api/config` fails with `Failed to load configs`, verify those tables exist in the production Postgres.
- If you must run the Stage 4 init from your local machine against Railway Postgres, use the public DB URL with SSL enabled; `postgres.railway.internal` will not resolve locally.

## 6. Pre-release / post-deploy checks
- `GET /api/health` responds 200 over HTTPS.
- Auth flow: login, `/api/auth/me`, logout, logout-all.
- Socket auth: invalid token rejected, valid token connected.
- Config sync: values persist after re-login.
- Same user in multiple browsers: config and manual tokens stay in sync.
- `logout-all` invalidates every open session for the same account.

## 7. Security checks before go-live
- Run `security-check.ps1` and review FAIL/WARN.
- Review `npm audit` for high/critical advisories.
- Verify no temporary localhost origins remain in `CORS_ORIGINS`.

## 8. Backup and recovery
- Keep daily PostgreSQL backups.
- Test restore in non-production.
- Keep rollback plan for app version + DB schema changes.
