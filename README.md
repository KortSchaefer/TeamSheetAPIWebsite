# TeamSheetAPIWebsite

## Ingredient catalog

The normalized process-lineage catalog lives at
`data/ingredient_catalog.json`. It contains 256 ingredients and supplies with
437 immediate parent relationships.

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
