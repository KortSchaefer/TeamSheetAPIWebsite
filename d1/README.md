# TeamSheet Studio D1 migrations

This directory is the immutable, Worker-side database history. It does not replay
the Python Alembic chain because the early Alembic revisions call the current
SQLAlchemy metadata and use conditional startup-repair behavior. Instead:

- `0001_initial_schema.sql` freezes the current 57-table SQLAlchemy end-state,
  including foreign keys, uniqueness constraints, and explicit indexes;
- repair-added defaults and columns from Alembic revisions `0001` through `0009`
  and `app/database.py` are folded into that clean baseline;
- `0002_seed_pos_categories.sql` preserves the idempotent POS V1 category seed
  from Alembic revision `0005`.

The Python startup repair functions remain only for the reference FastAPI/SQLite
application. Worker/D1 code must never execute equivalent runtime schema repairs.
All future D1 schema changes must be appended as numbered SQL migrations.

Generate the initial artifacts from metadata:

```powershell
.\venv\Scripts\python.exe scripts\generate_d1_schema.py
```

Verify without rewriting:

```powershell
.\venv\Scripts\python.exe scripts\generate_d1_schema.py --check
```

Apply only to isolated local state:

```powershell
npx wrangler d1 migrations apply teamsheet-studio-local --local --persist-to .wrangler/d1-schema-test
```

Never add `--remote` unless a separate task explicitly authorizes the target
environment and requires its backup/reconciliation procedure.

## Read-only SQLite data export

Export application data without modifying `team_sheet.db`:

```powershell
.\venv\Scripts\python.exe scripts\export_sqlite_to_d1.py export team_sheet.db `
  --output .wrangler\sqlite-to-d1\data.sql `
  --manifest .wrangler\sqlite-to-d1\manifest.json
```

The export is data-only and schema-independent. It discovers columns and
foreign keys from SQLite, emits parent tables first, uses explicit column lists,
escapes text and binary values, validates JSON/Boolean encodings, and excludes
`sqlite_%` tables plus the FastAPI-only `alembic_version` table. Apply it only
after creating a fresh local D1 schema. Do not import it remotely without a
separately approved rehearsal.

With the local Worker stopped, pass the isolated `--persist-to` directory to
the validator; it resolves the single non-metadata D1 SQLite file and
reconciles it:

```powershell
.\venv\Scripts\python.exe scripts\export_sqlite_to_d1.py validate team_sheet.db `
  .wrangler\sqlite-to-d1-test `
  --manifest .wrangler\sqlite-to-d1\manifest.json `
  --report .wrangler\sqlite-to-d1\validation.json
```

Validation exits nonzero for missing tables, row-count differences, or any
source/destination foreign-key violation. Never waive that failure silently.

## Sanitized staging data

Generate a fully synthetic dataset for the current D1 schema:

```powershell
.\venv\Scripts\python.exe scripts\generate_sanitized_staging_data.py `
  --output .wrangler\staging-sanitized\data.sql `
  --manifest .wrangler\staging-sanitized\manifest.json `
  --reconciliation .wrangler\staging-sanitized\reconciliation.sql
```

This dataset contains two synthetic identities, two synthetic inventory
locations, eight synthetic items and balances, and the normal menu-category
seed. It contains no copied users, employee numbers, POS credentials, voice
records, transcripts, object keys, orders, payments, counts, purchase orders,
receiving history, schedules, payouts, assignments, or audit records.
