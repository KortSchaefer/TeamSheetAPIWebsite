# TeamSheetAPIWebsite

## Cloudflare Worker foundation

The migration branch includes a TypeScript Worker that serves the unchanged
`public/` directory through Workers Static Assets. It currently implements only
`/health`, `/api/version`, `/`, and the existing `/static/...` compatibility
paths; FastAPI remains the reference backend for all business routes.

Install the local Worker toolchain and run it without remote bindings:

```powershell
npm install
npm run cf:dev
```

The local Worker is available at `http://127.0.0.1:8787`. Validate generated
binding types and run both Worker runtime and full-config integration tests with:

```powershell
npm run cf:check
npm run test:worker
```

These commands do not create Cloudflare resources. Deployment is intentionally
not exposed as a package script and requires a separate authorized migration step.
The scripts also prevent Wrangler from loading the existing FastAPI `.env` into
the Worker process.

## Ingredient catalog

The normalized process-lineage catalog is assembled from
`data/ingredient_catalog.json` and `data/bar_inventory_catalog.json`. Together
they contain 420 ingredients, beverages, supplies, and menu-use forms with 529
immediate parent relationships.

Validate the file without changing the database:

```powershell
.\venv\Scripts\python.exe scripts\import_ingredient_catalog.py --dry-run
```

Import or refresh it idempotently:

```powershell
.\venv\Scripts\python.exe scripts\import_ingredient_catalog.py
```

Managers can also load the bundled version with
`POST /ingredient-catalog/import-default`. Catalog browsing is paginated at
`GET /ingredient-catalog`, details and lineage are available at
`GET /ingredient-catalog/{catalog_id}`, and a catalog record becomes a
stockable store item through `POST /inventory/items/from-catalog`.

The catalog stores identity and process lineage. Quantities, locations, pars,
costs, purchase units, and vendors remain on the existing inventory tables.

The bar extension adds 164 normalized records. To import the catalog, create or
reuse the `Bar` location, and activate the 117 physically countable bottles,
kegs, syrups, purées, and beverage supplies with zeroed balances:

```powershell
.\venv\Scripts\python.exe scripts\import_bar_inventory.py
```

Use `--dry-run` to validate without writing, or `--location "Main Bar"` to
target another location. Managers can perform the same idempotent operation
through `POST /ingredient-catalog/import-bar-inventory`. Prepared cocktails,
wine-glass servings, and margarita variants remain searchable catalog records
but are not activated as stock, which prevents counting the same product twice.
When a case pack is not known, activation keeps the purchase unit equal to the
count unit rather than inventing a case-to-bottle conversion.

## Hands-free voice inventory

Managers and admins can open `/static/inventory-voice.html`, select a starting
location, and count through a headset while the phone remains down. The browser
streams speech to OpenAI Realtime transcription, and the API normalizes each
utterance against the store's active inventory items, aliases, units, and
locations. Counts stay in an append-only review trail. Finishing creates one
linked `DRAFT` inventory count per spoken location; it never changes balances
until the normal submit/post workflow is completed.

Install dependencies and apply the migration:

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe -m alembic upgrade head
```

Copy the voice settings from `.env.example` into `.env` and set
`OPENAI_API_KEY`. Realtime transcription defaults to
`gpt-realtime-whisper`; structured normalization defaults to
`gpt-5.6-luna`. Set `VOICE_INVENTORY_ENABLED=false` to disable the API.

Microphone capture and encrypted offline buffering require a secure browser
context. `http://localhost` works for desktop development, but a phone opening
the app over a LAN IP must use HTTPS. Production deployments should always
serve the full application over HTTPS.

Audio chunks use local storage in development. For production, set
`VOICE_STORAGE_BACKEND=s3` and provide the bucket, region/endpoint, and access
credentials from `.env.example`. Schedule an authenticated call to
`POST /inventory/voice/maintenance/cleanup-audio` to enforce the configured
24-hour retention window.

Each finished session provides CSV, styled XLSX, and print-ready HTML exports.
Unresolved voice entries block submission of linked drafts until a manager
corrects or rejects them.

## Spreadsheet count sheets

Open `/static/inventory-count.html` for the fast counting workspace. Selecting
a location creates or resumes one pre-populated draft whose rows distinguish an
uncounted blank from an explicit zero. Numeric edits are optimistic, batched,
revision-checked, and retained on the device while offline. Enter and arrow keys
move through the count column; mobile devices receive a numeric keypad.

Managers can filter to uncounted rows or exceptions, accept unusual values,
approve a completed location, and then deliberately post its balance changes.
CSV, styled XLSX, and print views preserve the visible physical count order.
Reorder mode and reusable templates allow each store to match its actual
walk-in, freezer, dry-storage, bar, or prep sequence.

Voice sessions now create and update these same draft rows as each utterance is
accepted. Starting voice from a sheet targets that sheet directly. The
spreadsheet also includes a lightweight guided mode that speaks each item and
accepts short quantity-only answers such as “six”, “zero”, “skip”, or “back”.

## Inventory dashboard

The dashboard at `/static/inventory.html` summarizes current inventory value,
estimated cost to restore stock to par, low/out-of-stock exceptions, active
count completion, count-review exceptions, category value, and the largest
physical-count variances. Inventory value uses positive on-hand quantity times
the item's base-unit cost. Reorder estimates use the shortage between on-hand
and par. An item is only treated as a stock alert after a minimum or par has
been configured, so newly activated zero-balance items do not overwhelm the
action center. The dashboard identifies missing item costs because value and
variance totals remain incomplete until those costs are entered.

## Easy Inventory Manager

Managers and admins can open the Easy Inventory Manager from
`/static/inventory.html` to create inventory in a keyboard-first grid or bulk
edit existing items. It supports spreadsheet paste previews, per-location
draft recovery, inherited defaults, pack-cost entry with calculated base-unit
costs, compact location/vendor creation, and responsive editable cards.

Preview requests perform matching and validation without writes. Commits save
the entire batch atomically with an idempotency key; nonzero opening quantities
are recorded as audited `EASY_MANAGER_OPENING_BALANCE` stock movements instead
of direct on-hand overrides. FastAPI and the Cloudflare Worker expose matching
`GET`, preview, and commit contracts under `/inventory/easy-manager`.

## AGM Floor

The selector wheel opens `/static/agm-floor.html` for manager/admin host
operations. Managers can draft and publish immutable floor versions, edit table
numbers and shapes, box-select and move table groups, reshape the main dining
area, and place draggable text blocks for non-table landmarks such as a host stand. An open service pins one
published layout and adds live seating, waitlist/reservations, table moves and
combinations, cleaning states, pacing, and TeamSheet-backed server rotation.

FastAPI and the Cloudflare Worker expose the matching `/agm` contract. The
Worker serializes service commands with `AGMServiceRoom`; D1 migration
`0005_agm_floor.sql` adds the operational tables. SMS notifications remain in a
consent-aware outbox with `PROVIDER_UNCONFIGURED` status until an adapter is
configured, and guest maintenance anonymizes contact data after 90 days.

## POS terminal V1

Open `/static/pos.html` for the touch-first POS terminal. A manager first opens
`/static/accounts.html` from the normal application, assigns each active
employee a unique 4–6 digit employee number, and chooses Server or Manager POS
access. Employee numbers are write-only: the application stores a slow password
hash plus a keyed lookup digest and never returns the number to the browser.
Set a strong, stable `SECRET_KEY` before provisioning production credentials.

POS V1 deliberately implements the table lifecycle before menu ordering:

- Servers see and operate only their own active tables.
- Managers see every active table and can transfer a table to an active server.
- New Table creates one empty check idempotently and prevents duplicate active
  table numbers.
- Print opens a receipt-formatted browser print view and records an audit event.
- Close Empty Check closes a zero-dollar check and archives the table without
  fabricating a payment.
- Menu categories and future order/payment controls are visible but disabled.
- The shared-terminal session locks after 45 seconds without touch or keyboard
  activity. Session cookies are HTTP-only and automatically become Secure when
  the request is served through HTTPS or an HTTPS reverse proxy.

Apply the latest database migration before using the terminal:

```powershell
.\venv\Scripts\python.exe -m alembic upgrade head
```

The migration seeds Drinks, Apps, Apps as Meal, Salads, Steaks, Chicken, Ribs,
Combos, Prime, Special, and Seafood as ordered POS categories. Table openings,
transfers, check prints, and empty-check closures remain in `pos_table_events`
as an append-only operational audit trail.
