---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: ["src/components/autopsy/AutopsyWorkbench.tsx"]
---

## Scope
The single-screen autopsy workbench (`src/app/page.tsx` → `AutopsyWorkbench`). Mode: Operate. Redesign: the old green-on-black terminal look is evidence only.

## Audience and task
Kiroween judges see it first in a demo; engineers use it for real migrations. Task: start a case (preset or upload), watch the five procedure steps, see which entities are rotting and why, open evidence, search records, take the generated API code.

## Constraints
Keep every function, role, label and test-visible text. Crimson means critical; X-Ray green means confident. Severity never by colour alone. Reduced motion respected.

## Direction contract
THESIS: An anatomical theatre after hours: the case is posted on the gallery wall as a coroner's notice in cream condensed poster type, and the specimens lie on a lamp-lit table below. Refuses the green-on-black hacker terminal and the grey card-grid admin dashboard.
OWN-WORLD: Warm theatre-slate ground (#14120F, raised #1E1B16, rules #3A332A), bone cream type (#EFE4CC, secondary #B9AE98), tallow lamp light (#E8B04F) for focus, running state and the lamp pool, crimson (#E3384F) only for critical, ochre for medium, formalin teal-grey for low, formalin green for confident regions. Anton for the notice and section titles, Archivo for UI text, JetBrains Mono only for data, offsets and code. Square-cornered panels with 1px rules, cream solid primary buttons.
STORY: The visitor reads the notice (what was examined, how many entities, how many critical), sees the rot glowing crimson on the table, opens a specimen for evidence, and leaves with the resurrected API.
FIRST VIEWPORT: Top bar with the NECROLEGACY wordmark, active case and New autopsy. Left column: the five-step Procedure rail, then the Specimens list. Main column: the Coroner's Notice headline across the top, the lamp-lit 3D table beneath at least 30rem tall, the X-Ray beside it for images. Search and generated code follow below the fold.
FORM: Pinned by the user ("darker, more serious autopsy theater with cream condensed poster type", Mobbin poster reference as loose inspiration); position 1 of 1. seed: none (unavailable). Signature move: the Coroner's Notice, a poster-scale cream condensed verdict that rewrites itself as each procedure step lands, above a table lit by a single overhead lamp pool.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved
No logo or tagline yet.
