# Phase 6 Checklist

- [ ] Deploy target selected (Railway)
- [ ] Production `.env`/variables created with `NODE_ENV=production`
- [ ] `FORCE_HTTPS=true` enabled in production
- [ ] `CORS_ORIGINS` restricted to real frontend domain(s)
- [ ] Railway service healthy (`GET /api/health`)
- [ ] DB initialized in Railway (`npm run db:init`)
- [ ] Auth/session flows re-validated in production URL
- [ ] Socket authentication re-validated in production URL
- [ ] `logout-all` explicitly re-validated without lockout interference
- [ ] `security-check.ps1` re-run against Railway URL and reviewed
- [ ] Backup + restore procedure documented and tested
