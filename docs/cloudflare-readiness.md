# Cloudflare Phase 0 Readiness Audit

Audit date: 2026-08-04  
Branch: `feat/cloudflare-migration`  
Reference application commit: `fa9eccb`  
Scope: read-only architecture and compatibility audit. No runtime behavior, Cloudflare resources, remote databases, DNS, or deployment configuration were changed.

## Executive conclusion

The application is a viable Cloudflare migration candidate, but it is not a lift-and-shift FastAPI deployment. The existing browser UI can be retained with a small compatibility router, while the backend requires a deliberate API and data-access port.

The recommended permanent target remains:

- Cloudflare Workers Static Assets for the contents of `public/`;
- a TypeScript Worker API preserving the current same-origin HTTP contract;
- D1 for relational state;
- private R2 storage for retained voice audio;
- Worker secrets for `SECRET_KEY`, `OPENAI_API_KEY`, and future provider credentials;
- a Cron Trigger for audio-retention maintenance;
- physically separate local, staging, and production bindings.

The main blockers are:

1. The Alembic history is not a standalone schema definition. Its first migration calls `Base.metadata.create_all()`, and later migrations create tables from live Python metadata. D1 needs an explicit, ordered SQL baseline.
2. The application is tightly coupled to synchronous SQLAlchemy sessions, ORM relationships, and repeated `db.commit()` calls. D1 is accessed through its Worker binding and prepared statements, so the persistence layer must be rewritten.
3. Authentication has pre-existing security issues that should not be reproduced in the Worker: public registration accepts an arbitrary role, JWTs are returned to JavaScript and copied into `localStorage` by two pages, access and refresh tokens have no distinguishing claim, and there is no CSRF protection.
4. The current `/static/...` URL contract does not naturally match a Workers Static Assets directory rooted at `public/`. A compatibility rewrite is required so existing links remain valid.
5. Voice retention depends on a local filesystem or boto3/S3 credentials; Workers must use a private R2 binding and scheduled cleanup.
6. Only 66 of 158 router method/path combinations are directly exercised by the current tests using a route-call heuristic. Several complete product domains have no route tests.

No single issue prevents the migration, but authentication, schema baselining, and contract capture must happen before broad endpoint porting.

## Repository snapshot

| Area | Current state |
|---|---|
| Backend | FastAPI, Uvicorn, synchronous SQLAlchemy 2, Pydantic, Alembic |
| Browser UI | 15 HTML pages plus `team-sheet-studio.css`, served from `public/` |
| Routers | 18 router modules, 158 decorated endpoints; plus `/` and `/health` in `app/main.py` |
| HTTP methods | 63 GET, 76 POST, 12 PUT, 2 PATCH, 5 DELETE |
| Access categories | 82 manager/admin, 60 authenticated user, 9 POS session, 7 public/signed/other |
| Database model | 57 tables, 411 mapped columns, 107 ORM relationships, 19 Python enums |
| Schema history | 9 Alembic revisions plus startup `create_all()` and SQLite repair hooks |
| Local database | Ignored `team_sheet.db`, 978,944 bytes at audit time |
| Local audio | Ignored `voice_audio/`, 420 objects totaling 2,950,421 bytes at audit time |
| Tests | 21 tests across 7 `test_*.py` files; no configured line/branch coverage report |
| Data files | Bundled ingredient and bar catalog JSON, test script Markdown, sample PO CSV |
| Cloudflare files | None yet: no `package.json`, Worker entrypoint, `wrangler.jsonc`, D1 SQL migrations, or Worker tests |

## Current application assembly

`app/main.py` performs substantial work at module import time:

1. creates every SQLAlchemy table with `Base.metadata.create_all(bind=engine)`;
2. invokes seven SQLite-specific schema repair functions;
3. creates the FastAPI application;
4. mounts `public/` at `/static`;
5. maps `/` specifically to `public/index.html`;
6. installs permissive CORS middleware;
7. registers all 18 routers.

This must be separated during the port. A Worker should not mutate schema during module initialization. D1 schema changes belong in versioned SQL migrations, and runtime initialization should be deterministic and side-effect free.

## Cloudflare platform fit

### Static assets

The existing UI is framework-free HTML/CSS/JavaScript and is well suited to Workers Static Assets. Cloudflare supports a `public/` assets directory, an `ASSETS` binding, and selective or unconditional `run_worker_first` routing ([official binding documentation](https://developers.cloudflare.com/workers/static-assets/binding/)).

Compatibility work is still required:

- Current pages live at `/static/<file>.html`, while an assets directory rooted at `public/` normally exposes `/<file>.html`.
- Existing links, redirects, export URLs, print popups, and user bookmarks assume `/static/`.
- `/` must continue to resolve to `index.html`.
- API routes do not share one `/api` prefix, so `run_worker_first` needs either explicit route-family patterns or a Worker-first dispatcher that falls back to `env.ASSETS.fetch()`.
- Direct API paths such as `/inventory/...`, `/pos/...`, and `/team-sheets/...` must never be mistaken for asset paths.

Recommended compatibility behavior: retain all existing API and `/static/` URLs, rewrite `/static/<path>` internally to the corresponding asset request, and optionally add canonical root-level asset URLs later as a separately approved change.

### Worker runtime

A TypeScript Worker is the lowest-risk permanent backend. The current Python dependencies include SQLAlchemy, psycopg2, Passlib/bcrypt, python-jose/cryptography, openpyxl, boto3, and synchronous OpenAI/httpx code. Reusing that dependency graph inside an isolate would create package and runtime risk without removing the need to replace SQLAlchemy/D1 access.

CPU and memory need measurement for catalog normalization, dashboard aggregation, and XLSX creation. Current Workers have a 128 MB memory limit, plan-dependent CPU limits, and static/worker bundle limits; deploy dry-runs should measure the generated bundle rather than assuming it fits ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).

### D1

D1 has SQLite SQL semantics, but application access is through a Worker binding, REST API, or Wrangler, not a SQLAlchemy `sqlite:///` connection ([D1 query guidance](https://developers.cloudflare.com/d1/best-practices/query-d1/)).

Required changes:

- replace ORM queries and relationship loading with explicit repository queries;
- bind all values in prepared statements;
- normalize enums to documented text values;
- choose and enforce one representation for Boolean, Decimal, date, datetime, and JSON values;
- replace multi-commit workflows with one D1 `batch()` when atomicity is required;
- preserve idempotency keys and optimistic revisions;
- add transient-write retry policy with bounded exponential backoff;
- review indexes against actual filters and joins;
- avoid enabling read replication for workflows that require immediate read-after-write consistency unless D1 Sessions are used deliberately.

D1 batches are transactional and roll back the sequence if one statement fails ([D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)). A single D1 database processes queries serially, so high-write paths must stay indexed and concise ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). The current restaurant/store workload appears modest enough for one database initially, but this must be load-tested around simultaneous POS and inventory activity.

### R2

R2 is the correct replacement for `voice_audio/`. A Worker can access a private bucket directly through an R2 binding without embedding S3 credentials ([R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)).

The port should:

- retain authenticated issuance of short-lived upload authority;
- namespace keys with environment, store, session, and random upload ID;
- keep bucket access private;
- record only object keys/metadata in D1;
- enforce size and content-type restrictions while streaming uploads;
- decide whether an issued upload is single-use or intentionally replayable;
- schedule cleanup and configure a defensive bucket lifecycle rule.

R2 lifecycle deletion can lag its configured expiration, so the application should treat D1 retention status as authoritative while the bucket rule acts as a safety net ([R2 lifecycle documentation](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).

### Secrets and scheduled work

Cloudflare secrets should hold runtime credentials; sensitive values must not be placed in Wrangler `vars` ([Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)). Staging and production require distinct secrets and resource bindings.

The application has no server-side background task runner. Audio cleanup is invoked when a voice session starts and through a manager-only maintenance endpoint. This should become a Worker `scheduled()` handler with an environment-specific Cron Trigger. Cloudflare supports different schedules per environment ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).

## Database and model audit

### Model inventory

The 57 mapped tables are grouped below. Names show `Model -> table`.

**Identity, workforce, and TeamSheet Studio (13)**

- `User -> users`
- `Employee -> employees`
- `Section -> sections`
- `Shift -> shifts`
- `TeamSheet -> team_sheets`
- `TeamSheetAssignment -> team_sheet_assignments`
- `SideworkTask -> sidework_tasks`
- `SideworkAssignment -> sidework_assignments`
- `OutworkTask -> outwork_tasks`
- `OutworkAssignment -> outwork_assignments`
- `StorePreference -> store_preferences`
- `DailyRoster -> daily_rosters`
- `TeamSheetPreset -> teamsheet_presets`

**Gift, PYOS, cobrand, and payouts (11)**

- `CobrandDeal -> cobrand_deals`
- `GiftTrackerEntry -> gift_tracker_entries`
- `PyosCredit -> pyos_credits`
- `PyosRequest -> pyos_requests`
- `PyosAudit -> pyos_audit`
- `PayoutTier -> payout_tiers`
- `PayoutRule -> payout_rules`
- `Prize -> prizes`
- `PrizeAssignment -> prize_assignments`
- `PayoutAdjustment -> payout_adjustments`
- `Season -> seasons`

**POS and menu (10)**

- `POSCredential -> pos_credentials`
- `POSTerminalSession -> pos_terminal_sessions`
- `POSTable -> pos_tables`
- `POSTableEvent -> pos_table_events`
- `MenuCategory -> menu_categories`
- `MenuItem -> menu_items`
- `RecipeItem -> recipe_items`
- `POSOrder -> pos_orders`
- `POSOrderItem -> pos_order_items`
- `POSPayment -> pos_payments`

**Ingredient, inventory, purchasing, counts, and voice (23)**

- `Ingredient -> ingredients`
- `IngredientLineage -> ingredient_lineage`
- `IngredientCatalogImport -> ingredient_catalog_imports`
- `StockMovement -> stock_movements`
- `InventoryLocation -> inventory_locations`
- `InventoryItem -> inventory_items`
- `InventoryBalance -> inventory_balances`
- `InventoryWeekdayTarget -> inventory_weekday_targets`
- `Vendor -> inventory_vendors`
- `VendorItem -> inventory_vendor_items`
- `PurchaseOrder -> inventory_purchase_orders`
- `PurchaseOrderLine -> inventory_purchase_order_lines`
- `InventoryCount -> inventory_counts`
- `InventoryCountLine -> inventory_count_lines`
- `InventoryCountTemplate -> inventory_count_templates`
- `InventoryCountTemplateLine -> inventory_count_template_lines`
- `InventoryVoiceSession -> inventory_voice_sessions`
- `InventoryVoiceUtterance -> inventory_voice_utterances`
- `InventoryVoiceEntry -> inventory_voice_entries`
- `InventoryItemAlias -> inventory_item_aliases`
- `InventoryVoiceSessionCount -> inventory_voice_session_counts`
- `InventoryReceiving -> inventory_receiving`
- `InventoryReceivingLine -> inventory_receiving_lines`

The models use 19 Python enums. D1 migrations should store their stable string values with explicit checks where useful. SQLAlchemy `Numeric` fields currently surface as `Decimal`; the Worker contract must preserve JSON serialization and arithmetic precision. Datetimes are declared with timezone-capable SQLAlchemy types but commonly populated with `datetime.utcnow()`, producing naive values and deprecation warnings. Select a UTC storage format before import and test round trips.

### Alembic inventory

| Revision | Purpose | D1 concern |
|---|---|---|
| `0001_inventory_workspace` | Adds stock movement compatibility columns, then calls `Base.metadata.create_all()` | Not a reproducible SQL baseline; behavior changes whenever Python models change |
| `0002_ingredient_catalog` | Adds catalog columns, creates import/lineage tables from metadata, adds indexes | Depends on live SQLAlchemy metadata and inspector behavior |
| `0003_voice_inventory` | Creates five voice tables from `Base.metadata` | No explicit SQL definition in migration |
| `0004_spreadsheet_count_sheets` | Creates template tables and adds count review/revision fields | Conditional inspector logic must become deterministic SQL |
| `0005_pos_terminal_v1` | Creates POS credential/session/table/event tables, extends orders/categories, seeds categories | Table definitions and seed behavior depend on Python metadata and runtime queries |
| `0006_repair_pos_table_request_id` | Repairs `pos_tables.client_request_id` and unique index | Repair migration has no downgrade and may create the whole table from metadata |
| `0007_purchase_order_csv_import` | Adds PO reference/import metadata and uniqueness indexes | Skips silently when base table is absent; no downgrade |
| `0008_inventory_planning` | Adds weekday targets/planning fields/PO location links and backfills targets | Data backfill and correlated SQL need D1-specific validation; no downgrade |
| `0009_store_blast_threshold` | Adds configurable BLAST minimum | Skips silently when table is absent; no downgrade |

`app/database.py` duplicates much of this behavior with seven SQLite repair functions that run at every application import. A fresh D1 schema cannot be built by replaying this Alembic chain independently of the Python model state. Phase 1 must generate and review an explicit `0001` D1 baseline containing all 57 tables, foreign keys, unique constraints, and indexes, followed by immutable D1 migrations.

### High-value persistence semantics to preserve

- inventory movement `source_event_key` idempotency;
- PO import source hash and vendor/reference uniqueness;
- POS table `client_request_id` idempotency;
- count-line and POS-table optimistic `revision` checks;
- append-only POS table events, PYOS audit, voice utterances, and corrected/superseded voice entries;
- inventory count approve/submit/post separation;
- receiving-to-order-line linkage and balance movement consistency;
- menu recipe depletion exactly once per closed sale;
- manager/server ownership and visibility constraints.

## Authentication, cookies, CORS, and authorization

### Current account authentication

- Passwords are hashed with Passlib. New hashes use PBKDF2-SHA256; legacy bcrypt and bcrypt-SHA256 hashes remain accepted.
- JWTs use HS256 and a shared `SECRET_KEY`.
- Access tokens last 60 minutes; refresh tokens last seven days by default.
- Login and registration set `HttpOnly`, `SameSite=Lax` access and refresh cookies.
- `Secure` is based only on `request.url.scheme` for account cookies.
- Protected routes accept either an OAuth2 Bearer token or the access-token cookie.
- There is no refresh endpoint, token revocation list, token version, issuer, audience, or token-type claim.
- Logout deletes browser cookies but cannot invalidate a copied JWT.

### Current POS authentication

- Managers assign a unique 4–6 digit employee number and an explicit Server/Manager POS role.
- A keyed HMAC lookup digest and a slow password hash are stored; the raw number is not returned.
- Successful login creates a random terminal token and stores only its SHA-256 hash.
- The POS cookie is `HttpOnly`, `SameSite=Strict`, path `/`, and becomes `Secure` when the request scheme or `x-forwarded-proto` is HTTPS.
- Sessions have an absolute expiration, 45-second default idle lock, explicit revocation, and employee/credential active checks.
- Table access is restricted to the owning server unless the POS principal is a manager.

### Security findings that must not be copied unchanged

| Severity | Finding | Migration requirement |
|---|---|---|
| Critical | `POST /auth/register` accepts `UserCreate.role`, including Manager/Admin, without authorization | Disable public privilege selection. Bootstrap the first admin through an explicit one-time procedure and make privileged account creation manager/admin-only |
| Critical | Login responses expose access and refresh JWTs to JavaScript; `gift-card-tracker.html` and `pick-your-sections.html` copy them into `localStorage` and client-readable cookies | Move to one server-managed `HttpOnly` session design; remove JS token persistence and Authorization fallback |
| High | Access and refresh JWTs have the same claims/signing key and no `typ` distinction; a copied refresh token can be presented as a Bearer credential | Add explicit token type and refresh rotation/revocation, or replace both with opaque D1-backed sessions |
| High | No CSRF token/origin validation exists for cookie-authenticated mutations | Add Origin/Host validation and a CSRF mechanism appropriate to the final session design |
| High | CORS is configured as wildcard origins with credentials, methods, and headers | For the same-origin Worker, remove CORS by default. If a separate client is approved, allow only named origins and required methods/headers |
| High | Authentication cookies use `request.url.scheme` while POS separately trusts `x-forwarded-proto` | Centralize secure-cookie policy; on public Cloudflare hosts always set `Secure` and verify proxy headers only in trusted deployment paths |
| High | Six-character maximum POS numbers have a small brute-force space and no IP/device/global rate limit | Add Worker/DO or D1-backed throttling in addition to credential lockout; preserve generic errors |
| Medium | POS lockout is keyed after the exact HMAC lookup. Wrong candidate numbers usually do not identify a credential, so per-credential failed-attempt counters do not materially slow exhaustive guessing | Apply rate limits before credential lookup and audit repeated failures |
| Medium | Signed local audio upload URLs are bearer capabilities valid for 15 minutes and can overwrite the same object during that window | Preserve short TTL and randomness, then decide/test single-use behavior, checksum validation, and replay policy in R2 |
| Medium | Extensive template-based `innerHTML` rendering creates an XSS review burden; escaping is present in many but not all rendering paths | Add CSP and audit every server/user-controlled interpolation before production |

Fixes that alter the public registration or token response contract must be documented as intentional security changes. Existing tests commonly self-register Admin users, so test setup must move to a trusted seed/helper rather than preserving the insecure endpoint behavior.

## Local filesystem and bundled-data audit

| Usage | Current implementation | Cloudflare disposition |
|---|---|---|
| Static files | `app/main.py` reads `public/index.html` and mounts `public/` | Workers Static Assets with `/static/` compatibility routing |
| Relational DB | `team_sheet.db` through SQLAlchemy SQLite URL | Export source only; replace runtime access with D1 |
| Voice audio | `Path.mkdir`, `write_bytes`, and `unlink` below `voice_audio/` | Replace with private R2 binding |
| Catalog JSON | `ingredient_catalog.py` reads two files below `data/` at runtime | Convert to versioned D1 seed/import artifacts or bundle as non-public Worker data; do not accidentally publish through assets |
| CSV imports | FastAPI `UploadFile`, decoded and parsed in memory | Parse request bodies/FormData in Worker with explicit byte/row limits |
| CSV exports | Generated in memory through `StringIO` | Straightforward Worker `Response` generation |
| XLSX exports | Generated in memory with openpyxl and `BytesIO` | Port to a Worker-compatible library and compare binary workbook behavior/visible formatting |
| Print views | Server-generated HTML for TeamSheet, inventory count, voice, and POS | Port as authenticated Worker HTML responses with escaping and CSP |

The data catalog is about 148 KB across the two JSON files and is not a size blocker. It should not be coupled to the Worker global initialization path. The current 420 local audio objects demonstrate that retention cleanup needs an operational schedule and reconciliation, even though the total size is currently small.

## CSV, XLSX, print, and import audit

Server-generated outputs:

- TeamSheet JSON, CSV, and print HTML;
- count-sheet CSV, styled XLSX, and print HTML;
- voice-session CSV, styled multi-sheet XLSX, and print HTML;
- POS receipt print HTML.

Browser-generated output:

- purchase-order CSV is built directly in `inventory.html`.

Uploads/imports:

- server roster CSV through `UploadFile`;
- daily roster CSV through `UploadFile`;
- purchase order CSV sent as JSON text after browser file reading;
- import detection supports comma, semicolon, tab, and pipe delimiters.

Current imports do not establish a general request-byte or row-count policy. Add explicit limits before the Worker port even though Cloudflare's outer request-body limits are much larger than normal restaurant CSV files. Preserve duplicate protection, source hashes, detected headers, overrides, row-level validation, and vendor/item matching.

XLSX is the largest export risk. The visual workbook contract should be fixture-tested for worksheet names, headers, widths, number formats, formulas if any, freeze panes, filters, colors, and printable content. Do not silently replace XLSX with CSV.

## OpenAI and voice audit

The voice flow has two OpenAI paths:

1. `POST /inventory/voice/sessions/{id}/realtime-token` makes a server-side request to `/v1/realtime/client_secrets` and returns an ephemeral client secret.
2. The browser uses that ephemeral value to establish a WebRTC call directly with `/v1/realtime/calls`.
3. Accepted transcripts return to the application, where `voice_inventory.py` uses the OpenAI Responses API for structured normalization.
4. If no OpenAI key is configured or normalization fails, deterministic local normalization is used and the fallback is recorded.

Positive migration properties:

- the durable OpenAI API key remains server-side;
- a hashed user/session identifier is sent as the safety identifier;
- transcript ingestion uses `client_event_id` and sequence controls;
- browser offline events are AES-GCM encrypted in IndexedDB;
- microphone capability checks correctly require HTTPS/localhost;
- the UI has a browser SpeechRecognition fallback;
- audio retention failure does not discard the transcript count.

Porting requirements:

- replace synchronous httpx/OpenAI SDK calls with native asynchronous `fetch` or a verified edge-compatible SDK;
- retain upstream timeouts and map provider errors to the existing 502/503 contract;
- validate the current OpenAI endpoint/model contract when implementing, because provider APIs are time-sensitive;
- preserve prompt version, model identifiers, structured schema, deterministic fallback, confidence/review behavior, and safety identifier;
- use `ctx.waitUntil()` only for non-critical post-response work. Count normalization and D1 persistence must complete before acknowledging success;
- consider Queues only if normalization is intentionally made asynchronous; that would be a user-visible contract change.

## Background, periodic, and offline work

There is no FastAPI `BackgroundTasks`, task queue, Celery/RQ scheduler, or server cron process in the repository.

Current periodic behavior is browser-side:

- POS idle timer and heartbeat refresh;
- voice VAD timer and SpeechRecognition restart;
- inventory count edit batching/retry;
- online/offline event flushing.

Current server maintenance is request-driven:

- voice audio cleanup occurs when a voice session starts;
- managers can call `/inventory/voice/maintenance/cleanup-audio`.

Cloudflare disposition:

- add a scheduled audio cleanup handler;
- retain request-time cleanup as a safe secondary path only if it remains inexpensive;
- preserve voice IndexedDB encryption and event ordering;
- note that count-sheet pending edits are stored unencrypted in `localStorage` and should contain operational counts only, never credentials;
- keep POS heartbeat requests lightweight because each currently updates `last_seen_at`, creating a D1 write on every authenticated session poll.

The POS heartbeat is a notable D1 write-amplification risk. Consider updating `last_seen_at` at a coarser interval or moving short-lived session activity to a Durable Object, while keeping the authoritative credential/session record in D1. Any such change requires concurrency and expiry tests.

## Frontend API-call inventory

Every functional page uses same-origin relative API URLs except the direct OpenAI Realtime WebRTC call. This is favorable for a single Worker deployment.

| Page | API families and notable calls |
|---|---|
| `accounts.html` | `/auth/me`, `/auth/logout`, `/pos/admin/access` |
| `gift-card-tracker.html` | auth, seasons, employees, daily rosters, gift tracker, cobrands, all payout subresources |
| `import-center.html` | `/imports/servers` |
| `index.html` | auth, employee rosters, server import |
| `inventory-count.html` | locations, templates, count-sheet create/read/batch/reorder/approve, count post, exports/print links |
| `inventory-voice.html` | locations/items, all active voice-session operations, audio upload, OpenAI Realtime call, export/print links |
| `inventory.html` | ingredient catalog, inventory dashboard/stock/items/locations/vendors, counts, planning targets, PO planner/import/create/update/submit/cancel, receiving |
| `login.html` | login, registration, current user |
| `pick-your-sections.html` | auth, employees, sections, all PYOS request/credit/approval operations |
| `pos.html` | POS PIN/session/bootstrap, table list/create/transfer, check print/close |
| `store-preferences.html` | store preference read/upsert |
| `team-sheet-studio.html` | auth, employees, sections, shifts, rosters/imports, preferences, TeamSheets, presets, exports/print |

Frontend compatibility tests must cover navigation URLs as well as fetch calls. The current app depends on cookies with `credentials: include`, relative redirects to `/static/login.html`, direct download anchors, browser print windows, microphone secure contexts, Wake Lock, IndexedDB, and localStorage.

## Route inventory

Access codes: **P** public or signed capability, **U** authenticated account user, **M** account Manager/Admin, **POS** authenticated POS terminal principal.

### `auth` — 6 routes

- `POST /auth/register` (P)
- `POST /auth/login` (P)
- `POST /auth/token` (P)
- `GET /auth/me` (U)
- `POST /auth/link-employee/{user_id}` (M)
- `POST /auth/logout` (P)

### `employees` — 5 routes

- `GET /employees` (U)
- `POST /employees` (M)
- `GET /employees/{employee_id}` (U)
- `PUT /employees/{employee_id}` (M)
- `DELETE /employees/{employee_id}` (M)

### `sections` — 3 routes

- `GET /sections` (U)
- `POST /sections` (M)
- `PUT /sections/{section_id}` (M)

### `shifts` — 3 routes

- `GET /shifts` (U)
- `POST /shifts` (M)
- `GET /shifts/{shift_id}` (U)

### `team_sheets` — 7 routes

- `GET /team-sheets` (U)
- `POST /team-sheets` (M)
- `GET /team-sheets/{team_sheet_id}` (U)
- `PUT /team-sheets/{team_sheet_id}` (M)
- `GET /team-sheets/{team_sheet_id}/export/json` (U)
- `GET /team-sheets/{team_sheet_id}/export/csv` (U)
- `GET /team-sheets/{team_sheet_id}/print` (U)

### `teamsheet_presets` — 2 routes

- `GET /teamsheet-presets` (U)
- `POST /teamsheet-presets` (M)

### `store_preferences` — 2 routes

- `GET /store-preferences` (U)
- `POST /store-preferences` (M)

### `daily_rosters` — 2 routes

- `GET /daily-rosters` (U)
- `POST /daily-rosters` (M)

### `imports` — 2 routes

- `POST /imports/servers` (M)
- `POST /imports/daily-roster` (M)

### `cobrands` — 3 routes

- `GET /cobrands` (U)
- `POST /cobrands` (U)
- `GET /cobrands/sellers` (U)

### `gift_tracker` — 2 routes

- `GET /gift-tracker` (U)
- `POST /gift-tracker` (M)

### `seasons` — 3 routes

- `GET /seasons` (U)
- `POST /seasons` (M)
- `DELETE /seasons/{season_id}` (M)

### `payouts` — 17 routes

- `GET /payouts/tiers` (U)
- `POST /payouts/tiers` (M)
- `PUT /payouts/tiers/{tier_id}` (M)
- `DELETE /payouts/tiers/{tier_id}` (M)
- `GET /payouts/rules` (U)
- `POST /payouts/rules` (M)
- `PUT /payouts/rules/{rule_id}` (M)
- `DELETE /payouts/rules/{rule_id}` (M)
- `GET /payouts/prizes` (U)
- `POST /payouts/prizes` (M)
- `PUT /payouts/prizes/{prize_id}` (M)
- `DELETE /payouts/prizes/{prize_id}` (M)
- `POST /payouts/prizes/assign` (M)
- `GET /payouts/prizes/assign` (U)
- `POST /payouts/adjustments` (M)
- `GET /payouts/adjustments` (U)
- `GET /payouts/summary` (U)

### `pyos` — 11 routes

- `GET /pyos/credits/me` (U)
- `GET /pyos/credits` (M)
- `POST /pyos/credits/grant` (M)
- `GET /pyos/requests` (U)
- `GET /pyos/occupied` (U)
- `POST /pyos/requests` (U)
- `POST /pyos/requests/manual` (M)
- `POST /pyos/requests/{request_id}/approve` (M)
- `POST /pyos/requests/{request_id}/deny` (M)
- `POST /pyos/requests/{request_id}/revoke` (M)
- `GET /pyos/audit` (M)

### `ingredient_catalog` — 5 routes

- `GET /ingredient-catalog` (U)
- `GET /ingredient-catalog/metadata` (U)
- `POST /ingredient-catalog/import-default` (M)
- `POST /ingredient-catalog/import-bar-inventory` (M)
- `GET /ingredient-catalog/{external_id}` (U)

### `inventory` — 46 routes

- `GET /inventory/locations` (U)
- `POST /inventory/locations` (M)
- `GET /inventory/items` (U)
- `POST /inventory/items` (M)
- `POST /inventory/items/from-catalog` (M)
- `PUT /inventory/items/{item_id}` (M)
- `GET /inventory/items/{item_id}/balances` (U)
- `PUT /inventory/items/{item_id}/balances` (M)
- `GET /inventory/settings/targets` (U)
- `PUT /inventory/settings/targets` (M)
- `GET /inventory/purchase-order-planner` (U)
- `GET /inventory/stock` (U)
- `GET /inventory/dashboard` (U)
- `GET /inventory/vendors` (U)
- `POST /inventory/vendors` (M)
- `POST /inventory/vendor-items` (M)
- `POST /inventory/movements` (M)
- `POST /inventory/waste` (M)
- `POST /inventory/adjustments` (M)
- `POST /inventory/transfers` (M)
- `GET /inventory/movements` (U)
- `GET /inventory/counts` (U)
- `GET /inventory/count-templates` (U)
- `POST /inventory/count-templates` (M)
- `GET /inventory/count-sheets` (U)
- `POST /inventory/count-sheets` (U)
- `GET /inventory/count-sheets/{count_id}` (U)
- `GET /inventory/count-sheets/{count_id}/export.csv` (U)
- `GET /inventory/count-sheets/{count_id}/export.xlsx` (U)
- `GET /inventory/count-sheets/{count_id}/print` (U)
- `PATCH /inventory/count-sheets/{count_id}/lines/{line_id}` (U)
- `POST /inventory/count-sheets/{count_id}/lines/batch` (U)
- `POST /inventory/count-sheets/{count_id}/reorder` (U)
- `POST /inventory/count-sheets/{count_id}/approve` (M)
- `POST /inventory/counts` (U)
- `POST /inventory/counts/{count_id}/submit` (U)
- `POST /inventory/counts/{count_id}/post` (M)
- `POST /inventory/purchase-orders/import-preview` (M)
- `POST /inventory/purchase-orders/import-csv` (M)
- `POST /inventory/purchase-orders/from-plan` (M)
- `POST /inventory/purchase-orders` (M)
- `GET /inventory/purchase-orders` (U)
- `PUT /inventory/purchase-orders/{order_id}` (M)
- `POST /inventory/purchase-orders/{order_id}/submit` (M)
- `POST /inventory/purchase-orders/{order_id}/cancel` (M)
- `POST /inventory/receiving` (M)

### `voice_inventory` — 18 routes

- `POST /inventory/voice/sessions` (M)
- `GET /inventory/voice/sessions/active` (M)
- `GET /inventory/voice/sessions/{session_id}` (M)
- `POST /inventory/voice/sessions/{session_id}/realtime-token` (M)
- `POST /inventory/voice/sessions/{session_id}/audio-upload` (M)
- `PUT /inventory/voice/sessions/{session_id}/audio/{upload_id}` (P: signed upload capability)
- `POST /inventory/voice/sessions/{session_id}/utterances` (M)
- `PATCH /inventory/voice/sessions/{session_id}/entries/{entry_id}` (M)
- `POST /inventory/voice/sessions/{session_id}/clarifications` (M)
- `POST /inventory/voice/sessions/{session_id}/pause` (M)
- `POST /inventory/voice/sessions/{session_id}/resume` (M)
- `POST /inventory/voice/sessions/{session_id}/offline` (M)
- `POST /inventory/voice/sessions/{session_id}/finish` (M)
- `POST /inventory/voice/sessions/{session_id}/abandon` (M)
- `GET /inventory/voice/sessions/{session_id}/export.csv` (M)
- `GET /inventory/voice/sessions/{session_id}/export.xlsx` (M)
- `GET /inventory/voice/sessions/{session_id}/print` (M)
- `POST /inventory/voice/maintenance/cleanup-audio` (M)

### `pos` — 21 routes

- `GET /pos/menu-categories` (U)
- `POST /pos/menu-categories` (M)
- `GET /pos/menu-items` (U)
- `POST /pos/menu-items` (M)
- `GET /pos/orders` (U)
- `POST /pos/orders` (U)
- `POST /pos/orders/{order_id}/items` (U)
- `POST /pos/orders/{order_id}/close` (M)
- `GET /pos/admin/access` (M)
- `PUT /pos/admin/access/{employee_id}` (M)
- `POST /pos/pin/login` (P)
- `POST /pos/pin/logout` (P)
- `GET /pos/pin/session` (POS)
- `GET /pos/terminal/bootstrap` (POS)
- `GET /pos/terminal/tables` (POS)
- `POST /pos/terminal/tables` (POS)
- `GET /pos/terminal/tables/{table_id}` (POS)
- `POST /pos/terminal/tables/{table_id}/transfer` (POS)
- `POST /pos/terminal/checks/{check_id}/print` (POS)
- `GET /pos/terminal/checks/{check_id}/print-view` (POS)
- `POST /pos/terminal/checks/{check_id}/close-empty` (POS)

## Test coverage audit

The existing suite was executed during this audit with an isolated in-memory database:

```powershell
$env:DATABASE_URL='sqlite+pysqlite:///:memory:'
.\venv\Scripts\python.exe -m pytest -q
```

Result: **21 passed, 0 failed, 964 warnings in 2.52 seconds**. The warnings are predominantly deprecated naive `datetime.utcnow()` usage and Pydantic v2 `.dict()` calls. They do not fail the current suite, but the datetime warnings matter when defining D1 timestamp serialization.

The suite primarily covers employees, ingredient activation, inventory/PO/count workflows, POS terminal V1, TeamSheet creation/export, BLAST preference, and voice normalization/count integration.

There is no line or branch coverage configuration. A static route-call heuristic found direct test-client calls covering 66 of 158 decorated method/path combinations (41.8%). This is not equivalent to code coverage, but it exposes contract gaps.

| Router | Directly exercised routes | Total routes |
|---|---:|---:|
| `auth` | 2 | 6 |
| `cobrands` | 0 | 3 |
| `daily_rosters` | 0 | 2 |
| `employees` | 5 | 5 |
| `gift_tracker` | 0 | 2 |
| `imports` | 0 | 2 |
| `ingredient_catalog` | 5 | 5 |
| `inventory` | 29 | 46 |
| `payouts` | 0 | 17 |
| `pos` | 10 | 21 |
| `pyos` | 0 | 11 |
| `seasons` | 0 | 3 |
| `sections` | 1 | 3 |
| `shifts` | 1 | 3 |
| `store_preferences` | 2 | 2 |
| `team_sheets` | 3 | 7 |
| `teamsheet_presets` | 0 | 2 |
| `voice_inventory` | 8 | 18 |

Additional gaps:

- no browser automation suite for the 12 functional pages;
- no Worker, D1 migration, or R2 tests yet;
- no explicit negative authorization matrix across user roles;
- no public-registration privilege-escalation test;
- no JWT expiry/type/refresh/revocation tests;
- no CSRF/CORS/security-header tests;
- no tests for audio upload signature expiry, replay, size, or cleanup route;
- no OpenAI realtime-token/provider-error contract tests;
- no test for the realtime browser handshake;
- no tests for imports router, payout/gift/cobrand/PYOS/seasons domains;
- no full migration test that creates a database only from migration files;
- no concurrency/load tests for inventory posting, receiving, POS table creation, or heartbeat writes.

Testing also has a migration-safety flaw: importing `app.main` executes `Base.metadata.create_all()` and SQLite repair hooks before dependency overrides are installed. A normal pytest run can therefore touch the ignored local `team_sheet.db` even though API requests later use the in-memory test engine. Migration work should set an isolated `DATABASE_URL` before module import and then remove import-time schema mutation.

## Risk register

| Priority | Risk | Impact | Required mitigation/gate |
|---|---|---|---|
| P0 | No explicit full schema baseline | D1 cannot be reproduced safely | Generate reviewed D1 SQL for all tables/indexes/FKs and prove empty-to-head migration locally |
| P0 | Public registration can create privileged users | Immediate account takeover risk | Replace with trusted bootstrap/invite/admin flow before production |
| P0 | JWTs exposed to JavaScript/localStorage | XSS can steal long-lived credentials | Adopt HttpOnly-only session design and remove client token copies |
| P0 | SQLAlchemy/ORM coupling | Backend cannot talk to D1 unchanged | Build typed D1 repository layer and port by bounded domain |
| P1 | Missing CSRF/origin policy and invalid wildcard credentialed CORS | Cross-origin mutation/security ambiguity | Same-origin default, explicit Origin checks, CSRF design, security tests |
| P1 | `/static/` asset URL mismatch | Existing navigation and bookmarks break | Add compatibility asset rewrite and browser route tests |
| P1 | Test gaps across 92 endpoint combinations | Contract regressions likely during port | Capture OpenAPI/fixtures and add domain contract tests before porting each router |
| P1 | Startup schema mutation and test import side effects | Uncontrolled schema drift/data mutation | Remove `create_all`/repair hooks from production startup after D1 baseline exists |
| P1 | POS short-number brute force and heartbeat write amplification | Unauthorized access and D1 contention | Global/device throttling; measure/coarsen heartbeat persistence |
| P1 | Multi-step business commits | Partial inventory/POS state if ported naively | Map transaction boundaries and use D1 batches/idempotent recovery |
| P1 | Local/S3 voice storage abstraction | Audio lost on isolate filesystem or credentials leaked | Private R2 binding, streaming limits, lifecycle and cleanup tests |
| P1 | Synchronous OpenAI normalization in request path | Latency/CPU/error handling regressions | Native async fetch, timeouts, deterministic fallback, idempotent persistence |
| P2 | openpyxl workbook generation | Bundle/runtime/memory incompatibility | Select edge library and fixture-test workbook parity |
| P2 | Naive UTC datetimes and Decimal/enum conversion | Data ordering or JSON drift | Define D1 storage/serialization conventions before export |
| P2 | Catalog files read from filesystem | Missing data or accidental public exposure | Versioned seed/import artifact, not runtime filesystem or public asset |
| P2 | Extensive inline scripts/HTML interpolation | CSP/XSS hardening is difficult | Inventory dynamic HTML, escape values, stage CSP rollout |
| P2 | D1 serial write processing | Overload under inefficient queries | Index review, query plans, retry policy, staging load test |

## Recommended porting order

### Gate 0 — preserve the contract before implementation

1. Export the current OpenAPI document.
2. Generate the authoritative method/path/access matrix from the routers.
3. Add representative success and error fixtures.
4. Add security tests for roles, cookies, and token behavior.
5. Add browser smoke coverage for current `/static/` navigation.

Exit condition: the reference application can be measured without relying on manual observation.

### Phase 1 — Worker/static foundation, no business data

1. Add TypeScript Worker tooling and tests.
2. Configure Workers Static Assets for `public/`.
3. Implement `/`, `/health`, `/api/version`, asset fallback, and `/static/` compatibility.
4. Define local/staging/production environment blocks without creating remote resources.
5. Add `.wrangler/`, generated state, bundles, `.dev.vars`, and dumps to `.gitignore`.

Exit condition: local Worker serves every existing page URL and health route without touching FastAPI or remote resources.

### Phase 2 — explicit D1 baseline and migration tooling

1. Generate a reviewed SQL baseline for all 57 tables.
2. Encode foreign keys, uniqueness, indexes, enum/text checks, and seed data explicitly.
3. Define date/time/Decimal/Boolean/JSON conversion rules.
4. Prove local empty-to-head migrations and foreign-key checks.
5. Build non-destructive SQLite export, D1 import, and reconciliation tools.

Exit condition: a fresh local D1 database can be built without importing Python or SQLAlchemy.

### Phase 3 — authentication vertical slice

1. Implement secure admin bootstrap and remove public role selection.
2. Implement the final HttpOnly session strategy.
3. Preserve PBKDF2 and legacy bcrypt verification through a tested compatibility path or an approved password migration.
4. Add CSRF/origin, cookie, expiry, logout/revocation, rate-limit, and role tests.
5. Port `/auth/me` and one read-only employee endpoint.

Exit condition: a seeded local user can authenticate securely and no token is readable by browser JavaScript.

### Phase 4 — workforce and TeamSheet Studio

Port in this order:

1. employees;
2. store preferences;
3. sections and shifts;
4. daily rosters and imports;
5. TeamSheets and presets;
6. JSON/CSV/print exports.

This domain has relatively simple data and exercises authentication, CRUD, query filters, nested serialization, CSV, HTML, and browser compatibility before inventory/POS risk is introduced.

### Phase 5 — ingredient catalog and inventory reads

1. catalog seed/import and lineage queries;
2. locations/items/balances/vendors;
3. stock and dashboard reads;
4. planning target reads and PO planner.

Exit condition: dashboard and catalog views match reference fixtures and query plans use intended indexes.

### Phase 6 — inventory writes, counts, purchasing, receiving

1. movements, waste, adjustments, and transfers;
2. count templates and draft sheets;
3. batched edits, revision conflicts, approval, submit, and post;
4. PO preview/import/idempotency;
5. plan-to-order creation, draft update, submit/cancel;
6. receiving and balance movements;
7. CSV/XLSX/print parity.

Exit condition: transaction, idempotency, reconciliation, concurrency, and export tests pass.

### Phase 7 — POS

1. POS access administration;
2. secure employee-number login and throttling;
3. terminal session/idle behavior with reduced write amplification;
4. category/menu read paths;
5. table lifecycle, transfer, print, and empty close;
6. legacy order/menu/payment APIs that are currently present but not enabled in POS V1 UI.

Exit condition: ownership, manager overrides, revisions, idempotency, audit events, and concurrent table creation pass tests.

### Phase 8 — voice inventory and R2

1. private R2 upload/read/delete adapter;
2. realtime ephemeral-token endpoint;
3. deterministic and OpenAI normalization;
4. session/utterance/entry state machine;
5. live count-sheet integration;
6. encrypted offline replay;
7. Cron/lifecycle cleanup;
8. CSV/XLSX/print parity and real-device HTTPS testing.

Exit condition: phone microphone, WebRTC, fallback recognition, offline recovery, review blocking, R2 retention, and exports pass staging acceptance.

### Phase 9 — remaining business domains

Port and test seasons, gift tracker, cobrands, payouts, and PYOS. They are later only because current automated coverage is absent, not because they are unimportant.

### Phase 10 — staging rehearsal and production preparation

1. deploy isolated staging bindings;
2. import sanitized data, then explicitly approved rehearsal data;
3. reconcile every table/domain total;
4. run browser, contract, load, security, and mobile voice acceptance;
5. create CI with protected production environment;
6. prepare a checkpointed cutover and rollback runbook.

Production resources, migrations, imports, DNS, and custom-domain changes remain separate explicitly authorized tasks.

## Phase 0 completion assessment

Phase 0 is complete when this report is reviewed alongside the test result for the branch. It authorizes no implementation or remote action. The next safe implementation task is Gate 0: capture the OpenAPI/contract fixtures and introduce tests for the critical authentication findings before scaffolding the Worker.
