#!/usr/bin/env python3
"""Fails when a Settings field of the API is missing from the README environment table."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTRA_VARIABLES = [
    "NEXT_PUBLIC_API_URL",
    "NEXT_PUBLIC_USE_MOCK",
    "NECRO_API_URL",
    "NECRO_API_TOKEN",
    "MCP_ANALYSIS_TIMEOUT_MS",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
]


def table_names(readme: str) -> set[str]:
    return set(re.findall(r"^\|\s*`([A-Z][A-Z0-9_]*)`", readme, flags=re.MULTILINE))


def check(readme: str, names: list[str]) -> list[str]:
    documented = table_names(readme)
    return [f"README environment table is missing {name}" for name in names if name not in documented]


def settings_names() -> list[str]:
    sys.path.insert(0, str(ROOT / "apps/api"))
    from app.core.config import Settings

    # A field documented under its preferred alias (DATABASE_URL) counts as documented.
    preferred = {"supabase_db_url": "DATABASE_URL"}
    return [preferred.get(name, name.upper()) for name in Settings.model_fields]


def main() -> int:
    readme = (ROOT / "README.md").read_text()
    problems = check(readme, [*settings_names(), *EXTRA_VARIABLES])
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
