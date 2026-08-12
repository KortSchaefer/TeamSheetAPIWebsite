# TeamSheet Studio Repository Guidance

## Scope

These instructions apply to the entire repository. The current migration target is a Cloudflare-hosted application with Workers Static Assets for the existing browser UI, a Worker API, D1 for relational data, and private R2 storage for voice audio and other uploaded files.

Preserve the existing FastAPI application as the reference implementation until a migrated route has contract tests and has passed staging acceptance. Do not remove or bypass working Python behavior merely to accelerate the Cloudflare port.

## Repository layout

- `app/main.py`: FastAPI application assembly, static-file mounting, router registration, and health endpoint.
- `app/config.py`: environment-backed application settings. Defaults are for local development only.
- `app/database.py`: SQLAlchemy engine/session setup and legacy SQLite repair helpers.
- `app/core/`: authentication and shared backend infrastructure.
- `app/models/`: SQLAlchemy models and persistence relationships.
- `app/routers/`: HTTP route implementations grouped by product domain.
- `app/schemas/`: Pydantic request and response contracts.
- `app/services/`: domain logic for inventory, POS, voice inventory, imports, and related workflows.
- `public/`: browser-delivered HTML, CSS, and JavaScript. Treat existing URLs and frontend API calls as compatibility requirements.
- `worker/`: TypeScript Cloudflare Worker entrypoint, D1/R2 repositories, authentication/security helpers, and runtime/integration/contract tests. It owns `/auth/register`, `/auth/login`, `/auth/token`, `/auth/logout`, `/auth/me`, read-only `GET /inventory/locations`, and the private R2-backed voice-audio upload/download/cleanup routes, in addition to `/health`, `/api/version`, static homepage delivery, and `/static/` compatibility routing.
- `contracts/`: generated FastAPI OpenAPI, route/auth/schema inventory, representative response fixtures, and reusable compatibility-test helpers. Treat these files as the reference API baseline; regenerate them only for an approved contract change.
- `d1/`: immutable Cloudflare D1 SQL migrations and a generated schema manifest reconciled from SQLAlchemy, Alembic, and legacy startup repairs. Only append migrations after the initial baseline is established.
- `wrangler.jsonc`: local-first Workers Static Assets configuration with distinct staging and production names; it contains no remote resource IDs or secrets.
- `package.json`: canonical local Worker development, type generation, checking, and test commands.
- `worker-configuration.d.ts`: generated Worker binding/runtime types. Refresh with `npm run cf:types` after changing `wrangler.jsonc`; the explicit `secrets.required` lists in Wrangler configuration keep local FastAPI variables out of Worker types and local runs.
- `alembic/versions/`: current Python/SQLAlchemy schema history. Never edit an already-applied migration in place.
- `tests/`: pytest coverage for employees, inventory, ingredient catalog, POS, TeamSheet Studio, and voice inventory.
- `data/`: normalized ingredient/bar catalog data and non-secret test fixtures.
- `scripts/`: catalog imports and migration/support utilities.
- `team_sheet.db`: ignored local development data. It is not a deployable or production-safe database.
- `voice_audio/`: ignored local development audio. It is not persistent Cloudflare storage.
- `.env.example`: non-secret configuration template. `.env` is local-only and ignored.

When Cloudflare scaffolding is added, keep its entrypoint, migrations, tests, and configuration clearly separated from the reference Python implementation. Document new top-level paths here.

## Local development commands

Run commands from the repository root in PowerShell.

Install or refresh Python dependencies:

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt
```

Apply the current local Alembic migrations:

```powershell
.\venv\Scripts\python.exe -m alembic upgrade head
```

Start the existing FastAPI development server:

```powershell
.\venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

The default local application is available at `http://127.0.0.1:8000`; its health check is `/health`, and browser pages are served beneath `/static/`.

Validate catalog inputs without changing the database:

```powershell
.\venv\Scripts\python.exe scripts\import_ingredient_catalog.py --dry-run
.\venv\Scripts\python.exe scripts\import_bar_inventory.py --dry-run
```

Verify that the committed FastAPI contract baseline is current without rewriting it:

```powershell
$env:DATABASE_URL = "sqlite+pysqlite:///:memory:"
.\venv\Scripts\python.exe scripts\export_api_contract.py --check
Remove-Item Env:DATABASE_URL
```

Use the package scripts as the canonical Cloudflare commands:

```powershell
npm install
npm run cf:dev
npm run cf:check
npm run test:worker
```

Verify the generated D1 schema and apply it only to isolated local state:

```powershell
.\venv\Scripts\python.exe scripts\generate_d1_schema.py --check
npx wrangler d1 migrations apply teamsheet-studio-local --local --persist-to .wrangler/d1-schema-test
```

Local Worker development must use local bindings and simulations unless a task explicitly authorizes a remote staging resource. The package scripts disable Wrangler's automatic FastAPI `.env` loading. No deploy script is defined intentionally; remote deployment remains a separately authorized action.

## Test and verification commands

Run the complete Python suite:

```powershell
.\venv\Scripts\python.exe -m pytest -q
```

Run a focused module while iterating:

```powershell
.\venv\Scripts\python.exe -m pytest -q tests\test_inventory.py
.\venv\Scripts\python.exe -m pytest -q tests\test_pos_terminal.py
.\venv\Scripts\python.exe -m pytest -q tests\test_voice_inventory.py
```

For application changes, run the smallest relevant tests first and then the complete suite before handoff. Treat warnings separately from failures and report both. Do not claim verification when a check was skipped or could not run.

Cloudflare work must add and maintain its own Worker unit/integration tests, D1 migration tests against a fresh local database, and API contract tests against the FastAPI reference. The final verification report for each phase must state:

- files changed;
- commands run and their results;
- API contract differences, if any;
- database or storage effects;
- remaining risks and rollback instructions.

## API compatibility requirements

- Preserve existing route paths, HTTP methods, accepted payloads, response bodies, status codes, and authorization behavior unless a change is explicitly approved and documented.
- Capture the current FastAPI OpenAPI specification and representative success/error fixtures before porting business routes.
- Keep frontend callers working without a broad URL rewrite. If a route must change, introduce and test a compatibility layer before changing browser code.
- Preserve manager/server role separation, POS ownership rules, inventory approval/posting semantics, idempotency keys, revision checks, and append-only audit histories.
- Preserve CSV/XLSX column ordering, filenames, number/date behavior, and authorization. Do not silently downgrade or remove an export format.
- Port one bounded product domain at a time. Keep FastAPI as the behavioral reference until the Worker implementation passes local contract tests and staging smoke tests.
- Any intentional incompatibility requires a written migration note, affected-client list, rollout plan, and user approval.

## Cloudflare target and environment separation

The intended permanent architecture is:

- Workers Static Assets serving `public/`;
- a Worker API preserving the current same-origin application contract;
- D1 for relational application data;
- private R2 buckets for voice audio and uploaded objects;
- Worker secrets for runtime credentials;
- separate local, staging, and production resources.

Maintain strict separation:

- **Local:** local Worker runtime, local D1 state, simulated/local R2, synthetic users, and synthetic inventory data. Local work must not depend on remote production services.
- **Staging:** a distinct Worker name, D1 database, R2 bucket, hostname, variables, and secrets. Staging may receive sanitized or explicitly approved rehearsal data only.
- **Production:** a distinct Worker, D1 database, R2 bucket, hostname, variables, and secrets. Production changes require an explicit user-approved cutover step.

Never reuse a D1 database ID, R2 bucket, Worker name, custom hostname, or secret set across staging and production. Environment bindings must be explicit in `wrangler.jsonc`; do not rely on an implicit default for remote commands.

Do not run remote D1 commands, create or delete Cloudflare resources, deploy a Worker, configure a custom domain, or change production bindings unless the current task explicitly authorizes that exact environment and action. A general request to implement code does not authorize deployment.

For current Cloudflare configuration fields, bindings, limits, compatibility dates, and CLI syntax, verify against the installed Wrangler schema and current official Cloudflare documentation instead of relying on memory.

## Database migration safety

- Treat `team_sheet.db` as source data during migration work. Do not edit, repair, vacuum, upgrade, or run application startup against the source copy used for an export rehearsal.
- Create a timestamped backup before every real-data rehearsal or cutover. Verify the backup can be opened before continuing.
- Convert Alembic/runtime-repair behavior into ordered, immutable D1 SQL migrations. Do not depend on application startup to repair a remote schema.
- Test every D1 migration from an empty local database and from a copy representing the previous migration level.
- Run foreign-key checks, schema comparisons, source/destination row-count reconciliation, and domain totals after imports.
- Never apply a migration to production before it has succeeded locally and against staging.
- Do not import real employee credentials, operational data, or audio into staging without explicit approval. Prefer sanitized fixtures.
- Stop on reconciliation mismatches. Report the mismatch and preserve both source and destination state; do not improvise destructive repairs.
- Do not drop tables, truncate data, rewrite migration history, or delete a D1/R2 resource without explicit approval and a verified recovery path.
- Receiving purchase orders, posting inventory counts, closing POS checks, and similar multi-record operations must remain atomic or idempotently recoverable.

## R2 and filesystem safety

- Worker and Container filesystems are not persistent application storage. Never port `team_sheet.db` or `voice_audio/` by writing them to a runtime filesystem.
- Keep R2 buckets private by default. Serve objects only through authenticated/authorized application routes or deliberately scoped signed access.
- Store object keys and metadata in D1; do not store audio or arbitrary file bodies in relational rows.
- Namespace R2 keys by environment and stable application identifiers. Avoid user-controlled raw paths.
- Preserve configured voice-audio retention and test cleanup without deleting unexpired or cross-environment objects.
- Do not expose R2 credentials to browser JavaScript. Prefer Worker bindings over S3 access keys inside the Worker.

## Secrets and sensitive data

- Never commit `.env`, `.dev.vars`, API tokens, access keys, database exports, real employee numbers, password/PIN material, JWT secrets, audio recordings, or production data fixtures.
- `.env.example` and any future `.dev.vars.example` may contain names and safe placeholders only.
- Store Cloudflare runtime secrets with Wrangler/Cloudflare secret facilities and CI credentials in protected repository/environment secrets.
- Do not echo, log, print, screenshot, or return secret values. Commands may reference secret names, never their values.
- Never paste a Cloudflare API token, OpenAI API key, production `SECRET_KEY`, or storage credential into source, configuration committed to Git, test snapshots, or chat output.
- Scope Cloudflare tokens to the minimum required account, zone, and resources. Use separate credentials or protected environments for staging and production where practical.
- Keep OpenAI calls server-side. The browser must not receive the OpenAI API key or a reusable provider credential.
- Treat database dumps and reconciliation output as sensitive. Write them only to ignored paths and remove or archive them according to the approved runbook.

If a possible secret is discovered in tracked history or tool output, stop publishing work, avoid repeating the value, and report the affected file/credential name so it can be rotated.

## Git and change discipline

- Work for this migration belongs on `feat/cloudflare-migration` or a deliberately derived migration branch until production readiness is approved.
- Inspect `git status` and the relevant diff before editing. Preserve unrelated user changes and never use destructive Git cleanup commands.
- Keep commits focused by migration phase or product domain. Do not combine a database migration, broad UI rewrite, and deployment configuration unless they are inseparable and reviewed together.
- Do not push, merge to `main`, open a pull request, or deploy solely because implementation tests pass; those actions require explicit authorization.
- Never commit generated local D1 state, `.wrangler/`, `node_modules/`, database dumps, recordings, or secret files. Update `.gitignore` when new tooling introduces local state.

## Definition of done

A Cloudflare migration task is complete only when its scoped behavior is implemented, relevant local tests pass, API compatibility is verified, data/storage side effects are documented, the diff is reviewed, and no unauthorized remote or production mutation occurred. Staging and production deployment are separate tasks with separate approval and verification requirements.
