# Product Rules: NecroLegacy

## Pitch
NecroLegacy is a "Digital Autopsy" workbench (Kiroween 2026, Frankenstein category). It stitches legacy fixed-width/COBOL/POS batch dumps and scanned legacy documents into a LangGraph multi-agent forensic engine, an ML outlier scorer, and an interactive Three.js 3D visualizer. It surfaces silent data rot and generates modern FastAPI wrappers.

## Target Users
Enterprise engineering teams modernizing legacy ERP, POS and logistics systems.

## Pipeline (order is fixed)
1. `vision_extractor` (image input only)
2. `schema_archaeologist`
3. `ml_rot_scorer`
4. `rot_detector`
5. `api_resurrector`

## UX Constraints
- Healthy entities pulse steadily; entities with critical anomalies glow crimson with animated trace arcs.
- Every 3D interaction has a keyboard and screen-reader equivalent.
- Respect `prefers-reduced-motion`; never rely on color alone.
- The Vision X-Ray overlay marks confident regions green and low-confidence or defective regions crimson.
- Built-in presets are synthetic and contain no real personal or financial data.

## Domain Rules
- Deterministic checks and ML scoring run before any LLM call. LLMs explain findings; they never compute scores.
- Orphan foreign keys, byte-offset overflows and negative inventory are always `critical`.
