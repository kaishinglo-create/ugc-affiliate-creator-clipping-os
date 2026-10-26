# Deployment

- Set DATABASE_URL, SESSION_JWT_SECRET, APP_ENV, CORS_ORIGIN.
- Run npm ci (postinstall generates Prisma client).
- Run npm run db:migrate:deploy.
- Run npm start.
