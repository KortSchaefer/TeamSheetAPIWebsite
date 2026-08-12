# Cloudflare rollout runbook

The Cloudflare Worker is the target runtime for the application UI and API. FastAPI remains the behavioral reference until the staging acceptance checks in this runbook pass. Staging and production must use separate Workers, D1 databases, R2 buckets, secrets, and Durable Object state.

## Resource map

| Environment | Worker | D1 | Private R2 |
| --- | --- | --- | --- |
| Staging | `teamsheet-studio-staging` | `teamsheet-studio-staging` | `teamsheet-studio-voice-staging` |
| Production | `teamsheet-studio-production` | `teamsheet-studio-production` | `teamsheet-studio-voice-production` |

The production D1 binding deliberately has no committed `database_id` until the account owner creates or selects the production database. Record the resulting ID in `wrangler.jsonc` before the first production dry run. Do not reuse the staging ID.

## Local release gate

Run from the repository root:

```powershell
node scripts/check-worker-route-coverage.mjs
node node_modules\wrangler\bin\wrangler.js types
node node_modules\typescript\bin\tsc --noEmit
node node_modules\vitest\vitest.mjs run --config vitest.worker.config.ts
node node_modules\vitest\vitest.mjs run --config vitest.integration.config.ts
python -m pytest
node node_modules\wrangler\bin\wrangler.js deploy --env staging --dry-run --outdir .wrangler/dry-run/staging
```

All commands must pass from a clean D1 migration history. Never edit an applied migration; add the next numbered migration.

## Staging deployment

1. Confirm account and resource scope without changing it:

   ```powershell
   node node_modules\wrangler\bin\wrangler.js whoami
   node node_modules\wrangler\bin\wrangler.js d1 list
   node node_modules\wrangler\bin\wrangler.js r2 bucket list
   node node_modules\wrangler\bin\wrangler.js secret list --env staging
   ```

2. If `SECRET_KEY` is absent, set a unique staging value through the interactive secret command. Never commit it:

   ```powershell
   node node_modules\wrangler\bin\wrangler.js secret put SECRET_KEY --env staging
   ```

3. Apply migrations to staging and deploy only the staging environment:

   ```powershell
   node node_modules\wrangler\bin\wrangler.js d1 migrations apply DB --env staging --remote
   node node_modules\wrangler\bin\wrangler.js deploy --env staging
   ```

4. Smoke-test the deployed URL:

   - `GET /health` returns `200` and `status: ok`.
   - `GET /api/version` reports `environment: staging` and `runtime: cloudflare-workers`.
   - Manager login/logout and `/auth/me` work.
   - POS configuration bootstrap, layout revision conflict, PIN login, table creation, item entry, print, and close work.
   - Team-sheet create/read/CSV/print work.
   - Gift tracker, payout summary, PYOS, and a sanitized CSV import work.
   - Inventory voice audio upload/download uses the staging R2 bucket.
   - AGM service state is isolated to staging.

Use synthetic or sanitized data only. Do not upload the production SQLite database or production audio during staging acceptance.

## Production approval gate

Before creating resources or changing traffic, the owner must provide all of the following:

- the Cloudflare account and production hostname/zone;
- whether existing SQLite rows and voice audio must be migrated;
- the maintenance window and acceptable write freeze;
- confirmation that a D1 export and source database backup have been captured;
- final smoke-test owner and rollback decision-maker.

Then create or select the production D1 database and R2 bucket, set the production `database_id`, set `SECRET_KEY`, run the production dry run, apply migrations, and deploy the Worker. Promote traffic atomically; do not use a split percentage because UI assets, POS sessions, Durable Object state, and database schema must stay on one compatible version.

## Rollback

For Worker-code regressions, list versions and roll back to the last accepted version:

```powershell
node node_modules\wrangler\bin\wrangler.js versions list --env production
node node_modules\wrangler\bin\wrangler.js rollback --env production
```

D1 migrations are forward-only. Do not delete tables or reverse a production migration during incident response. Roll Worker code back to a version compatible with the migrated schema, then ship an additive corrective migration. If data itself is corrupt, stop writes and restore from the approved D1 export under the incident owner’s direction.
