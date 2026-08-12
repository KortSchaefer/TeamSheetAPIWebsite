# Full Cloudflare staging deployment

**Run date:** 2026-08-11 (America/Chicago)  
**Worker:** `teamsheet-studio-staging`  
**URL:** `https://teamsheet-studio-staging.schaeferkort.workers.dev`  
**Version:** `d76f0741-dc01-4dfb-b697-3ba738f3de4c`

## Result

The entire FastAPI application route surface is now owned by the Cloudflare Worker. The previously missing POS configuration/terminal, workforce, team-sheet, gift tracker, payout, PYOS, and CSV import domains use D1-native implementations. Static UI assets, private voice audio in R2, and AGM Durable Object state remain on the same staging Worker.

This deployment is a staging release, not a production cutover approval. The production Worker, D1 database, R2 bucket, hostname, and traffic were not created or modified.

## Safety and data

- Pre-migration D1 export: `.wrangler/backups/teamsheet-studio-staging-pre-pos.sql`
- Export SHA-256: `856519A3B68E05F0DF0FEE793084CB583CED6DF72B95260896DD7751ECCD2E4E`
- Applied migration: `0006_pos_button_management.sql`
- `PRAGMA foreign_key_check` returned no rows after deployment.
- Staging continues to use its separate D1 and R2 resources.
- Existing fixed synthetic staging manager data was used for authenticated read-only smoke requests.

## Verification

| Check | Result |
| --- | --- |
| FastAPI route ownership | All 206 operations covered by 13 Worker route groups |
| Worker unit suite | 38 passed |
| Worker integration suite | 15 passed |
| FastAPI/Python reference suite | 40 passed, 1 skipped |
| TypeScript | Passed |
| Wrangler staging dry run | Passed |
| Wrangler production dry run | Passed; no production mutation |
| Worker startup | 19 ms |
| Public health/version | `ok`, `staging`, `cloudflare-workers` |
| POS button editor asset | HTTP 200 |
| Unauthenticated POS admin route | HTTP 401 |
| Authenticated domain reads | auth, employees, team sheets, gift tracker, payouts, PYOS, POS all HTTP 200 |
| D1 migration ledger | `0001` through `0006` present |
| D1 foreign keys | No violations |

The cross-domain integration test creates and clones a nested team sheet, exports CSV, upserts gift sales, calculates a tier payout, creates a manager-approved PYOS assignment, and imports a server CSV against a freshly migrated D1 database. The dedicated POS integration test creates a configurable product with a required modifier, exercises revision conflict handling, logs in through a PIN, opens a table, and rings the configured item into its check.

## Remaining production gates

Production promotion needs the owner’s explicit production hostname/zone, data-and-audio migration choice, maintenance/write-freeze window, and rollback ownership. The production D1 `database_id` must be filled with a newly created or explicitly selected production database; the staging ID must never be reused. The exact commands and rollback procedure are in `docs/cloudflare-rollout-runbook.md`.
