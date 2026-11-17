#!/usr/bin/env python3
"""Fails when a dependency manifest lists a GUI OpenCV build or GPU runtime wheels (Railway image size)."""
import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN = re.compile(r"^(opencv-python|torch|nvidia-.*|cuda.*)$")
REQUIRED = "opencv-python-headless"
SKIP_DIRS = {"node_modules", ".venv", ".git", ".next", "dist"}


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name.strip().lower())


def requirement_name(line: str) -> str | None:
    text = line.split("#", 1)[0].strip()
    if not text or text.startswith("-"):
        return None
    match = re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", text)
    return normalize(match.group(0)) if match else None


def packages_in(path: Path) -> list[str]:
    if path.name == "package.json":
        data = json.loads(path.read_text())
        return [normalize(n) for key in ("dependencies", "devDependencies") for n in data.get(key, {})]
    if path.name == "pyproject.toml":
        project = tomllib.loads(path.read_text()).get("project", {})
        groups = [project.get("dependencies", []), *project.get("optional-dependencies", {}).values()]
        return [n for group in groups for spec in group if (n := requirement_name(spec))]
    return [n for line in path.read_text().splitlines() if (n := requirement_name(line))]


def manifests(root: Path) -> list[Path]:
    found: list[Path] = []
    for pattern in ("requirements*.txt", "pyproject.toml", "package.json"):
        found += [p for p in root.rglob(pattern) if not SKIP_DIRS & set(p.relative_to(root).parts)]
    return sorted(found)


def check(root: Path) -> list[str]:
    problems: list[str] = []
    for path in manifests(root):
        rel = path.relative_to(root)
        problems += [f"{rel}: forbidden package {name}" for name in packages_in(path) if FORBIDDEN.match(name)]
    api = root / "apps/api/requirements.txt"
    if api.exists() and REQUIRED not in packages_in(api):
        problems.append(f"apps/api/requirements.txt: missing required package {REQUIRED}")
    return problems


def main() -> int:
    problems = check(ROOT)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
