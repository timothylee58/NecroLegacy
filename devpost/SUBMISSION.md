# NecroLegacy: Devpost submission copy

**Category:** Frankenstein · **Event:** Kiroween 2026, Build with Kiro
**Tagline:** A digital autopsy for legacy data.

**Links:** live app <https://necrolegacy-web.onrender.com> · code <https://github.com/timothylee58/NecroLegacy> · demo video: _paste the YouTube or Vimeo link here_

## Inspiration

Every company runs something nobody dares to touch: a mainframe ledger, a warehouse batch file from 1994, a scan of a printed manifest. The data inside has been quietly rotting for years, and the people who understood it have left. We wanted a tool that opens the file, shows what is wrong and why, and hands back something modern to build on.

## What it does

Drop in a fixed-width or COBOL dump, a copybook, or a photo of a printed table. A five-agent pipeline runs in a fixed order:

1. **vision_extractor** (images only) finds the table grid and reads each cell, locally first.
2. **schema_archaeologist** infers entities, keys and relationships from raw bytes.
3. **ml_rot_scorer** scores outliers with an Isolation Forest and projects records into 3D with PCA.
4. **rot_detector** runs deterministic checks. Orphan foreign keys, byte-offset overflows and negative inventory are always critical. A language model then explains the findings.
5. **api_resurrector** generates a typed FastAPI wrapper, syntax-checks it, and indexes the records for plain-word search.

Results appear as a coroner's notice, an interactive 3D Autopsy Table (healthy entities glow steadily, entities with critical rot glow crimson), a raw-dump view, and a Vision X-Ray that marks confident regions green and smudged or torn cells crimson. A Kiro MCP server exposes `inspect_legacy_schema` and `query_rot_anomalies`, so Kiro can examine a legacy schema from the editor. The three built-in presets are synthetic and contain no personal or financial data.

## How we built it with Kiro

- **Spec-driven:** a 19-requirement spec (EARS acceptance criteria), a design document and a 28-task plan. Kiro worked through the tasks one by one.
- **Steering files:** three always-on files (stack, product rules, code standards) kept every change on the same rules, such as "deterministic checks and ML scoring run before any LLM call; LLMs explain findings and never compute scores".
- **MCP server:** a Kiro tool for querying rot without leaving the editor.
- **Stack:** Next.js 15, React 19, Three.js, Framer Motion; FastAPI, LangGraph, OpenCV, scikit-learn, Pydantic v2; Neon Postgres with pgvector; Upstash Redis; deployed on Google Cloud Run and Render. The LLM router speaks Amazon Bedrock or any OpenAI-compatible endpoint, and runs on a free tier in the live deployment.

## Challenges

- **Free LLM tiers are unreliable.** The vision model on our first provider hit rate limits all day, and the second returned gateway errors and timeouts. Rather than wait for a better free tier, we made local OCR good enough: re-reading each cell at smaller scales fuses dot-matrix dots into strokes tesseract can read. On the faded manifest, mean confidence went from 0.35 to 0.86 with no model call, while the genuinely smudged and torn cells stay flagged.
- **Degraded results must not be cached.** A run that finished after an LLM call failed used to be replayed from Redis for 24 hours. Runs that finish degraded are now recomputed, and the cache key carries a pipeline version.
- **Scale-to-zero is honest but slow.** Cloud Run cold starts take about 20 seconds, so the first click used to fail. The page now wakes the API on load, session creation waits up to 45 seconds, and the status line says what is happening.

## Accomplishments

- 270 API tests, 145 web unit tests, 16 browser end-to-end tests with accessibility checks, and 21 MCP tests, all green in CI.
- A live smoke test of the deployed site (24 checks) that covers all three presets, search, code download, the X-Ray and mobile layout.
- Keyboard and screen-reader equivalents for every 3D interaction, and a reduced-motion path for every animation.

## What we learned

Put the deterministic work first and let the model explain. It made the product testable, and it meant the app kept working through every provider outage we hit.

## What's next

Real COBOL copybook edge cases (REDEFINES, packed decimals), more input formats, and a paid LLM tier for the vision fallback on scans local OCR cannot read.

## Built with

`nextjs` `react` `typescript` `three.js` `fastapi` `python` `langgraph` `opencv` `scikit-learn` `postgresql` `pgvector` `redis` `google-cloud-run` `render` `neon` `upstash` `kiro` `mcp`

## Credits

Music in the demo video: *Toccata and Fugue in D minor, BWV 565* by Johann Sebastian Bach, performed by Norbert Schenk
(organ of the Evangelische Kirche Solms-Albshausen, 2017). Licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), via
[Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Bach,_Toccata_und_Fuge_d-moll_BWV_565,_Norbert_Schenk.mp3).
Trimmed, faded out and lowered under the narration. Paste this into the YouTube or Vimeo description as well.
