# API compatibility contracts

`contracts/fastapi/` is the frozen reference contract for the existing FastAPI
application. It is intentionally separate from runtime code and contains:

- `openapi.json`: the complete generated OpenAPI document and component schemas;
- `routes.json`: every registered API operation, request/response schema references,
  status code, and authentication/authorization classification;
- `routes.md`: the same route inventory in a reviewable table;
- `fixtures/`: deterministic representative success and error responses.

Regenerate the baseline only when an intentional FastAPI contract change has been
approved:

```powershell
$env:DATABASE_URL = "sqlite+pysqlite:///:memory:"
.\venv\Scripts\python.exe scripts\export_api_contract.py
Remove-Item Env:DATABASE_URL
```

Normal validation must use check mode, which does not rewrite snapshots:

```powershell
$env:DATABASE_URL = "sqlite+pysqlite:///:memory:"
.\venv\Scripts\python.exe scripts\export_api_contract.py --check
Remove-Item Env:DATABASE_URL
```

The Python tests exercise the committed fixtures against an isolated in-memory
FastAPI database. To compare already-ported public endpoints against a running
Worker, set `WORKER_CONTRACT_BASE_URL`. By default this checks only
`health_success`; select additional public fixtures with the comma-separated
`WORKER_CONTRACT_FIXTURE_IDS` variable as those endpoints are ported.

Never update snapshots merely to make a compatibility failure disappear. Review
the FastAPI change, the affected callers, and the Worker behavior first.
