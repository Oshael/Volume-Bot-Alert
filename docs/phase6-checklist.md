# Phase 6 Checklist

## Validated in production (2026-03-08)
- [x] Deploy target selected (Railway)
- [x] Production variables created with `NODE_ENV=production`
- [x] `FORCE_HTTPS=true` enabled in production
- [x] `CORS_ORIGINS` restricted to real frontend domain(s)
- [x] Railway service healthy (`GET /api/health`)
- [x] DB initialized in Railway, including Stage 4 tables required by `/api/config`
- [x] Auth/session flows re-validated in production URL
- [x] Socket authentication re-validated in production URL
- [x] `logout-all` explicitly re-validated without lockout interference
- [x] Frontend config persistence re-validated in production URL
- [x] Backup + restore procedure documented

## Still pending / follow-up
- [ ] `security-check.ps1` re-run against the final Railway URL after the latest backend/frontend deploys
- [ ] Restore test executed from a fresh backup in a non-production environment
- [ ] Phase 6 docs kept aligned when the newer HTML is migrated

## Operational constraint
- [x] Current production topology documented as `single replica only`
