# Cloudflare Staging Acceptance Report

**Run date:** 2026-08-04 (America/Chicago)  
**Branch:** `feat/cloudflare-migration`  
**Worker:** `teamsheet-studio-staging`  
**URL:** `https://teamsheet-studio-staging.schaeferkort.workers.dev`  
**Accepted version:** `522d43c3-fb1f-4cb9-98f8-1a564e551a8e`

## Decision

The inventory and voice-inventory migration slice is accepted on staging. All FastAPI inventory and voice-inventory paths now have Worker routes, D1-backed persistence, authentication and manager authorization, private R2 audio storage, retention cleanup, and CSV/XLSX/print exports. The existing FastAPI implementation remains available and production was not modified.

This is not approval for a whole-application production cutover. Other application domains still need to be ported, and staging needs an `OPENAI_API_KEY` secret before OpenAI Realtime transcription and LLM normalization can be accepted there. Without that secret, the UI deliberately falls back to browser speech recognition.

## Safety and deployment

- D1 reported no unapplied staging migrations.
- A deployment dry run succeeded before the first deployment.
- Final Worker startup time was 24 ms.
- The private staging D1 and R2 bindings were unchanged.
- The scheduled audio cleanup remains `17 * * * *`.
- Pre-run D1 backup: `.wrangler/staging-inventory-voice-20260804-223212/before.sql`
- Backup SHA-256: `BD1EDD0949E252DFDC5E6B194CFE51BE8130E8BFD3824C62475B210F06AE8B20`
- No production Worker, D1 database, R2 bucket, secret, route, or deployment was created or modified.

## Automated verification

| Check | Result |
|---|---|
| Type generation and TypeScript | Passed |
| Worker unit tests | 7 files, 30 tests passed |
| Worker integration tests | 4 files, 13 tests passed |
| Full FastAPI/Python suite | 34 passed, 1 skipped |
| Dependency audit | 0 vulnerabilities after pinning patched `undici` |
| Diff whitespace check | Passed; line-ending notices only |

The Python suite still emits 968 existing deprecation warnings, primarily for `datetime.utcnow()` and Pydantic `.dict()`.

## Inventory acceptance

- Locations, catalog items, balances, stock, dashboard, movements, waste, adjustments, and atomic transfers work through D1.
- Dashboard value, reorder estimates, count completion, review totals, and latest count variances are populated from D1 rather than placeholders.
- Daily target settings, purchase units, tolerances, preferred vendors, planner rows, draft purchase orders, CSV preview/import, submission, cancellation, and receiving are covered locally.
- Count creation, spreadsheet editing, voice-linked sheets, approval, posting, CSV, XLSX, and print routes are implemented.
- Purchase-order responses include item names, location names, remaining quantities, pack units, and received quantities required by the existing UI.
- Ingredient and bar-catalog imports are available without loading the entire catalog on every request.

## Voice acceptance

- `next` and `bump` split one phrase into multiple item counts.
- Pause, resume, finish, abandon, offline, and location-switch commands are implemented.
- Unclear phrases remain review-blocking; corrections create auditable replacement entries and clarification resolution is available.
- Client event and sequence idempotency is enforced.
- Voice sessions launched from a count sheet update that exact sheet on finish.
- Reopening an already-linked sheet recovers the linked session instead of creating a conflicting link or returning 500.
- Private R2 upload and authenticated download passed with an exact byte comparison.
- Expired audio cleanup removed every synthetic test object.
- CSV included its BOM and exact audit header order.
- OpenPyXL loaded the Worker XLSX files successfully. Voice sheets were `Count Summary`, `Voice Audit`, and `Needs Review`; count-sheet headers, filters, and frozen panes matched the FastAPI layout.

The staging realtime-token endpoint correctly returned 503 because `OPENAI_API_KEY` is not configured. This is a controlled fallback, not a missing route.

## Browser acceptance

The deployed inventory dashboard and voice UI were tested at an actual 390×844 viewport:

- no horizontal overflow;
- inventory dashboard loaded live totals and latest variances;
- linked voice counts displayed in the spreadsheet and review UI;
- a completed linked session reopened into review mode without starting the microphone;
- no inventory or voice-inventory 404 request failures;
- the browser denied speech recognition in the automated harness, while manual phrase input and API transcription workflow checks passed;
- no new Worker error logs were produced during the final smoke requests.

Existing Operations Hub fallback warnings for unported employee, host, and SA roster APIs remain outside this migration slice.

## Reconciliation and cleanup

The synthetic staging run was removed after testing. Relevant before/after counts matched exactly:

| Table group | Before | After |
|---|---:|---:|
| Users | 3 | 3 |
| Inventory locations | 2 | 2 |
| Inventory items | 8 | 8 |
| Inventory balances | 8 | 8 |
| Inventory counts and lines | 0 | 0 |
| Voice sessions, utterances, entries, and links | 0 | 0 |
| Voice-audio metadata | 0 | 0 |
| Stock movements | 0 | 0 |

`PRAGMA foreign_key_check` returned no violations after cleanup. Twelve synthetic R2 objects from microphone and upload tests were removed by retention cleanup; two additional browser-test keys were explicitly removed, leaving no test audio metadata or sessions.

## Remaining dependency

Configure `OPENAI_API_KEY` interactively in staging, then repeat live microphone transcription and normalization acceptance on a real mobile browser:

```powershell
npx wrangler secret put OPENAI_API_KEY --env staging
```

Enter the key only in Wrangler's hidden prompt. Do not paste it into source, shell history, logs, or chat. After that check passes, continue porting the remaining non-inventory domains before considering production cutover.
