#!/usr/bin/env bash
# Verifies apps/web/src/types/autopsy.ts against the FastAPI OpenAPI document and the mock events against Pydantic.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
py="${PYTHON:-$root/apps/api/.venv/bin/python}"

(cd "$root/apps/api" && PYTHONPATH=. "$py" scripts/dump_openapi.py ../web/contract/generated/openapi.json)
(cd "$root/apps/web" && node contract/generate.mjs && pnpm exec tsc -p contract/tsconfig.json)
(cd "$root/apps/web" && NEXT_PUBLIC_USE_MOCK=true pnpm exec vitest run src/lib/mock-events.dump.test.ts)
(cd "$root/apps/api" && "$py" -m pytest tests/contract -q)
