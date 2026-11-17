#!/usr/bin/env python3
"""Fails when any .gitignore rule ignores a file under .kiro/ (the spec history must stay committable)."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def check(root: Path) -> list[str]:
    kiro = root / ".kiro"
    if not kiro.is_dir():
        return [".kiro directory is missing"]
    files = [str(p.relative_to(root)) for p in sorted(kiro.rglob("*")) if p.is_file()]
    if not files:
        return []
    # --no-index so already-tracked files are still judged against the patterns.
    proc = subprocess.run(
        ["git", "check-ignore", "--no-index", "--stdin"],
        cwd=root,
        input="\n".join(files),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode not in (0, 1):
        return [f"git check-ignore failed: {proc.stderr.strip()}"]
    return [f"{line}: ignored by .gitignore" for line in proc.stdout.splitlines() if line]


def main() -> int:
    problems = check(ROOT)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
