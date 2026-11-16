import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
spec = root / ".kiro/specs/digital-autopsy-engine"
text = (spec / "tasks.md").read_text()
body = text.split("## Tasks", 1)[1].split("## Task Dependency Graph", 1)[0]

items = []
for block in re.split(r"(?m)^(?=- \[ \] \d+\. )", body):
    m = re.match(r"- \[ \] (\d+)\. (.+)", block)
    if m:
        items.append({"id": m.group(1), "title": m.group(2).strip(),
                      "details": block.strip(), "done": False, "notes": ""})

prd = {
    "goal": f"Implement every task (required and optional) in {spec}/tasks.md, "
            "following requirements.md and design.md in the same folder.",
    "rules": [
        "Read requirements.md, design.md and tasks.md before starting an item.",
        "Do one item per iteration: implement every sub-task in its details, including optional (*) test sub-tasks.",
        "After finishing a sub-task, change its checkbox in tasks.md to [x] (keep the * marker). Mark the top-level task [x] when all its sub-tasks are done, then set done=true for the item here.",
        "Verify with real commands (pnpm typecheck/lint/test, pytest with Hypothesis, ruff, next build) before marking an item done. Checkpoint items require all tests to pass.",
        "Use python3.12 for apps/api with a venv at apps/api/.venv. Use pnpm for JS workspaces.",
        "Tests must never call real ILMU, Claude, Supabase or Redis services. Use respx, fakeredis and stubs as the design specifies. Never hardcode secrets.",
        "Follow .kiro/steering conventions: only 'why' comments, TypeScript strict, ARIA requirements.",
        "Commit after each item with a descriptive message. Never force push or rewrite history. Do not commit .venv, node_modules or .env files.",
        "If an item is blocked by something only the user can supply, record the blocker in the item's notes and move on.",
    ],
    "items": items,
}
(root / ".agents/ralph/digital-autopsy-engine.json").write_text(json.dumps(prd, indent=2))
print(len(items), [i["id"] for i in items])
