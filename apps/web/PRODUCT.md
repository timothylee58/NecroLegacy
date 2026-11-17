# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Primary first audience: Kiroween 2026 judges** watching a live demo or the submission video. They decide in minutes, mostly from the built-in presets.
- **Real users: enterprise engineers** modernizing legacy ERP, POS and logistics systems, who run actual batch dumps, copybooks and scanned manifests through the workbench and copy the generated API code into a migration.
The workbench must read as credible engineering to the second group while being legible and memorable to the first.

## Product Purpose
NecroLegacy is a "Digital Autopsy" workbench. A user drops a legacy fixed-width dump, COBOL copybook, POS/logistics CSV or scanned legacy document (or picks a preset). A fixed five-step pipeline (`vision_extractor` for images, `schema_archaeologist`, `ml_rot_scorer`, `rot_detector`, `api_resurrector`) infers the hidden schema, scores statistical outliers, explains data rot and generates Pydantic v2 + FastAPI code. Success: the user can see where the data is rotten, why, and leave with a working modern API wrapper.

## Positioning
Deterministic checks and ML scoring decide the findings; LLMs only explain them. The output is evidence (row numbers, confidence scores, sample rows) plus runnable code, not a chat answer.

## Operating Context
- Single-screen workbench: Necro_Dropzone, progress rail streamed over SSE, 3D Autopsy Table (Three.js constellation of entities and records), Entity_List and text summary, Node_Inspector_Drawer, Vision X-Ray overlay for image input, semantic search panel, generated code view with download.
- Used on desktop during demos and real work; must remain usable on mobile and at 200% zoom.
- Kiro MCP server exposes the same engine inside Kiro IDE.

## Capabilities and Constraints
- Upload limits: 5 MB text, 10 MB images. Accepted: .dat, .txt, .csv, .cpy, .png, .jpg, .jpeg.
- Severity vocabulary: `low`, `medium`, `critical`. Orphan foreign keys, byte-offset overflows and negative inventory are always critical.
- Fixed colour semantics: critical anomalies are crimson; Vision X-Ray confident regions are green and low-confidence or defective regions crimson.
- Stack is fixed by the repo: Next.js 15, React 19, TypeScript strict, Tailwind, shadcn/ui, Framer Motion, Three.js.

## Brand Commitments
- Name: NecroLegacy. Concept vocabulary: autopsy, necro, resurrection, rot.
- Visual reference volunteered by the user (binding in spirit, loose in execution): a Halloween poster with cream condensed poster type on charcoal. Direction chosen by the user: a darker, more serious autopsy theater with cream condensed poster type; the reference is inspiration, not something to copy.
- No logo or tagline exists yet. [Undecided]

## Evidence on Hand
- Three synthetic presets in `sample-dumps/`: 1994 Mainframe Ledger Dump, Corrupted F&B Warehouse POS Batch, Faded Dot-Matrix Manifest.
- No customers, testimonials, benchmarks or press exist. Do not fabricate any.

## Product Principles
1. Evidence before atmosphere: every themed element must still point at a real finding.
2. Credible to engineers, legible to judges in seconds.
3. Severity is never conveyed by colour alone.
4. The 3D scene has a full keyboard and screen-reader equivalent.

## Accessibility & Inclusion
WCAG 2.2 AA: keyboard operation everywhere, visible focus (3:1, 2 px), 4.5:1 text contrast, `prefers-reduced-motion` respected, screen-reader summary of 3D anomaly state, usable at 200% zoom.
