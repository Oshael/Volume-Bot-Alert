# Phase 6 Runbook (Hardening + Deploy)

## 1. Production environment
- Copy `.env.example` to `.env` on the server.
- Set `NODE_ENV=production`.
- Set `FORCE_HTTPS=true`.
- Set strict `CORS_ORIGINS` to your final frontend domain(s) only.
- Use a strong `JWT_SECRET`.

## 2. Process management
- Run Node with restart policy (systemd/pm2).
- Keep app listening on `127.0.0.1:3000` behind reverse proxy.

## 3. Reverse proxy and TLS
- Use `deploy/nginx/volume-alert-server.conf.example` as baseline.
- Issue TLS certificate (Let's Encrypt).
- Verify HTTP -> HTTPS redirect.

## 4. Pre-release checks
- `GET /api/health` responds 200 over HTTPS.
- Auth flow: login, `/api/auth/me`, logout, logout-all.
- Socket auth: invalid token rejected, valid token connected.
- Config sync: values persist after re-login.

## 5. Security checks before go-live
- Run `security-check.ps1` and review FAIL/WARN.
- Review `npm audit` for high/critical advisories.
- Verify no dev origins in CORS.

## 6. Backup and recovery
- Daily PostgreSQL backup.
- Restore test in non-production environment.
- Keep rollback plan for app version + DB schema changes.
