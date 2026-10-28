# Release Checklist

## Pre-release
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm run build` passes
- [x] `npm test` passes (29/29)
- [x] `npx prisma migrate status` up to date
- [x] No secrets in tracked source
- [x] `.env.example` updated
- [ ] Production secrets provided (SESSION_JWT_SECRET, DATABASE_URL)
- [ ] Deployment platform selected and credentials available

## Deploy
- [ ] Set APP_ENV=production
- [ ] Provision PostgreSQL and run `npm run db:migrate:deploy`
- [ ] `npm ci` (runs prisma generate)
- [ ] `npm run build`
- [ ] `npm start` (node dist/src/index.js)
- [ ] Verify `/health` and `/ready`
- [ ] Verify auth flow and workspace isolation

## Post-deploy
- [ ] Smoke test frontend URL
- [ ] Check logs for errors
- [ ] Verify CORS origin matches deployed URL
- [ ] Document rollback command

## Rollback
- Revert to previous Git commit and redeploy, or restart previous build artifact.
- Restore database from backup if migration caused data loss (migrations are additive; rollback of schema requires manual SQL).
