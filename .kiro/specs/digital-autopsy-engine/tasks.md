# Implementation Plan: NecroLegacy Digital Autopsy Engine

## Overview

This plan builds the NecroLegacy monorepo from an empty repository in the delivery order fixed by Requirement 19.8. Phase 1 creates the repository scaffolding and the Next.js web app on typed Mock_Data (including the Autopsy_Table, Vision X-Ray and accessibility work). Phase 2 builds the FastAPI service (parser, copybook, sanitizer, LLM router, five LangGraph nodes, SSE, cache, vector search, Docker) and replaces the mock client with an HTTP client without editing the TypeScript types. Phase 3 adds the MCP server, then CI, README, LICENSE check and repository checks. Each task builds on the previous ones and the last tasks wire everything together. Languages: TypeScript (web, MCP) and Python 3.12 (API). The design adds no steering files or hooks, so none are planned.

## Tasks

### Phase 1: Repository scaffolding and web app on Mock_Data

- [x] 1. Repository scaffolding
  - [x] 1.1 Create the monorepo skeleton
    - Add `pnpm-workspace.yaml` (`apps/web`, `packages/mcp-server`), root `package.json`, `tsconfig.base.json` (strict), and empty-but-tracked directories via placeholder files for `apps/api`, `packages/mcp-server`, `sample-dumps`
    - Add `.env.example` listing every variable from the design's configuration table (`WEB_ORIGIN`, `REDIS_URL`, `SUPABASE_DB_URL`, `ILMU_API_KEY`, `ILMU_BASE_URL`, `ILMU_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OCR_ENGINE`, `CACHE_TTL_SECONDS`, `SANITIZER_MAX_CHARS`, `MAX_CONCURRENT_SESSIONS`, `API_TOKEN`, `LOG_LEVEL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_USE_MOCK`, `NECRO_API_URL`, `NECRO_API_TOKEN`) with empty values
    - Verify the existing `.gitignore` ignores `.env` but no pattern matches anything under `.kiro/`
    - _Requirements: 19.1, 19.5, 17.7, 17.10_
  - [x] 1.2 Write the seeded preset generator
    - Create `scripts/generate_presets.py` (fixed seed, Pillow as dev-only dependency) that writes `sample-dumps/1994_mainframe_ledger_dump.dat`, `sample-dumps/corrupted_fnb_warehouse_pos_batch.txt` (multi-record-type, 2-char prefix, cross-entity foreign keys, orphan FKs, negative stock, empty branch codes) and `sample-dumps/faded_dotmatrix_manifest.png`
    - The PNG is at least 1,000 px wide, at most 10 MB, has a table of at least 5 rows by 3 columns with a smudged digit, a torn total and a misaligned column, and carries no EXIF or text chunks
    - All data is synthetic with no real names, emails, phones, government IDs, account or card numbers
    - Run the generator and commit the three outputs
    - _Requirements: 19.2, 19.3, 19.10, 4.13_
  - [x] 1.3 Scaffold `apps/web`
    - Create the Next.js 15 App Router app with React 19, TypeScript `strict`, Tailwind, shadcn/ui (button, dialog, sheet, toggle, radio-group), Framer Motion, Three.js, Vitest + Testing Library + fast-check, Playwright + `@axe-core/playwright`
    - Create `src/app/{layout.tsx,page.tsx,globals.css}` with a global `focus-visible` outline of at least 2 px
    - `next.config.ts` throws naming `NEXT_PUBLIC_API_URL` when it is missing and `NEXT_PUBLIC_USE_MOCK` is not `"true"`
    - Add `tsc --noEmit`, lint and `vitest run` scripts
    - _Requirements: 19.1, 17.8, 17.9, 18.2_

- [x] 2. Web types, mock data and client abstraction
  - [x] 2.1 Define the wire types
    - Create `apps/web/src/types/autopsy.ts` with every type from the design's TypeScript section (`NodeName`, `Severity`, `BoundingBox`, `VisionCell`, `VisionDefect`, `VisionResult`, `SchemaField`, `Entity`, `Anomaly`, `SpatialPoint`, `SessionEvent` union, `SchemaPayload`, `MlResult`, `RotResult`, `ResurrectionResult`, `SearchResponse`, `CreateSessionResponse`, `ErrorResponse`, `PresetId`)
    - Keys are snake_case to match the API wire format
    - _Requirements: 19.9, 10.2, 10.3, 11.13, 12.12_
  - [x] 2.2 Implement upload validation
    - Create `src/lib/file-validation.ts` exporting the shared limits (text 5,242,880, image 10,485,760), a case-insensitive extension check for the seven extensions, a `>` size comparison so the exact limit passes, and an image signature check reading the first 8 bytes with `file.slice(0, 8).arrayBuffer()`
    - Return typed rejection reasons that carry the alert text (seven extensions, 5 MB limit, 10 MB image limit)
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.8_
  - [x] 2.3 Write unit tests for file validation
    - Cover extensions in mixed case, exact-limit and limit+1 sizes for text and image, PNG/JPEG signature mismatches
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.8_
  - [x] 2.4 Build the mock autopsy fixtures and event player
    - Create `src/lib/mock-autopsy.ts` with fixtures: ledger preset (3 entities: one critical orphan FK, one `statistical_outlier`, one clean; 600 points per entity including a flagged and an unflagged cluster), a text-input event script (first event `vision_extractor` skipped `text_input`), and an image fixture (5 rows by 4 columns, one `smudged_digit`, one `torn_total`, one `misaligned_column`, SVG data-URI image generated from the same boxes)
    - Provide a timed generator that emits `started` and `completed` events per node ending with a `terminal` event, plus a rot_detector failure variant and a skipped-ML variant
    - _Requirements: 11.13, 12.12, 10.2, 10.5, 6.8, 19.8_
  - [x] 2.5 Define `AutopsyClient` and the mock implementation
    - Create `src/lib/api-client.ts` with the `AutopsyClient`, `SessionInput`, `SessionHandlers` interfaces and `createClient()` returning the mock client when `NEXT_PUBLIC_USE_MOCK === "true"`
    - Implement `MockClient` (createSession, subscribe with `lastEventId` replay, search over fixtures, getAnomalies with severity and entity filters, presetImageUrl)
    - _Requirements: 19.8, 19.9, 16.2, 14.3_
  - [x] 2.6 Implement the fetch-based SSE client
    - Create `src/lib/sse-client.ts` with `openSessionStream(url, lastEventId, handlers)` using `fetch` + `ReadableStream`, an `id:`/`event:`/`data:` frame parser tolerant of arbitrary chunk splits, `Last-Event-ID` header, duplicate suppression by highest seen ID, retries at 1, 2, 4, 8, 16 s, attempt counter reset on success, `onConnectionLost()` after the fifth failed attempt, and no retry after a `terminal` event
    - _Requirements: 10.7, 10.9_
  - [x] 2.7 Write unit tests for the SSE client
    - Use fake timers to assert delays 1, 2, 4, 8, 16 s, resume from the last ID, stop after 5 failures and no duplicate delivery
    - _Requirements: 10.7, 10.8, 10.9_
  - [x] 2.8 Implement the workbench reducer and selectors
    - Create `src/lib/session-reducer.ts`: pure reducer over `SessionEvent | UiAction` with the state fields from the design (`phase`, `nodeStatus`, `currentNode`, `vision`, `schema`, `ml`, `rot`, `resurrection`, `selectedEntityId`, `searchHits`, `connection`, `servedFromCache`, `inputKind`)
    - Add selectors `entitySeverity`, `anomaliesByEntity`, `flaggedRegions`, and the mapper from API types to `SceneGraph`
    - A failed node preserves earlier results and a rot_detector failure leaves `api_resurrector` skipped
    - _Requirements: 10.2, 10.3, 10.4, 10.11, 9.9, 11.7_
  - [x] 2.9 Write unit tests for the reducer
    - Cover vision skipped first for text, failure preserving earlier results, ML skipped, cache indicator
    - _Requirements: 10.5, 10.11, 6.8, 15.5_

- [x] 3. Necro_Dropzone
  - [x] 3.1 Build `DropzoneModal.tsx`
    - shadcn `Dialog` with a drop target (`role="button"`, `tabIndex=0`, Enter/Space opens the file input with `accept=".dat,.txt,.csv,.cpy,.png,.jpg,.jpeg"` and `multiple`) and exactly three Presets as a `role="radiogroup"` with roving tabindex (Arrow keys move, Enter/Space selects and submits)
    - Rejections render a `role="alert"` and keep the previous session and an enabled picker; pairing rule: one `.cpy` plus one data file are sent together, a lone `.cpy` is a layout-only session, two non-`.cpy` files are rejected
    - Upload uses `AbortSignal.timeout(10_000)`; timeout or network error shows a `role="alert"` with a Retry button and creates no session
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.9, 1.10, 1.13_
  - [x] 3.2 Write component tests for the dropzone
    - Cover alerts for bad extension and oversize, dispatch within 500 ms, keyboard-only preset selection, retry after timeout
    - _Requirements: 1.2, 1.4, 1.9, 1.10, 1.13_

- [x] 4. Autopsy_Table 3D scene
  - [x] 4.1 Implement scene helpers
    - Create `src/lib/scene/layout.ts` (seeded `mulberry32(hash(entityNames))` force layout, 200 iterations, sphere radius 6), `palette.ts` (crimson `#DC143C`, slate `#94A3B8`), and `webgl.ts` (throwaway-canvas probe for `webgl2` then `webgl`)
    - _Requirements: 11.1, 11.5, 11.7, 11.11_
  - [x] 4.2 Write unit tests for layout determinism
    - Same entity names give identical positions; points equal node position plus a constant scale times coordinates
    - _Requirements: 11.5, 11.7_
  - [x] 4.3 Implement `AutopsyScene` class
    - Create `src/lib/scene/AutopsyScene.ts` (no React imports) with `setGraph`, `setHighlights`, `setReducedMotion`, `resize`, `dispose`
    - Node spheres with a pulse of one cycle per 2 s for entities without Anomalies, crimson nodes and animated shader arcs on edges touching critical Anomalies, one `THREE.Points` per entity (flagged crimson, others slate) at `nodePosition + 1.5 * (x, y, z)`, raycaster picking calling `onSelect`
    - Reduced-motion mode: no pulse or moving arc; teal halo ring for healthy, crimson fill plus solid thick arc and diamond marker for critical; render on demand
    - RAF only while visible and intersecting; `dispose()` cancels RAF, removes observers and listeners, disposes geometries, materials and textures, calls `renderer.dispose()` and `forceContextLoss()`; pixel ratio capped at 2
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.10, 11.12_
  - [x] 4.4 Write unit test for scene disposal
    - Stub `WebGLRenderer` and assert every created geometry and material has `dispose` called exactly once across repeated `setGraph` calls and `dispose()`
    - _Requirements: 11.12_
  - [x] 4.5 Implement `AutopsyCanvas.tsx`
    - Thin React shell loaded with `next/dynamic({ ssr: false })`; creates the scene in `useEffect` and disposes on cleanup (Strict-Mode safe); canvas has `role="img"` and `aria-describedby` for the summary; renders an empty-state message when there are zero entities; on no WebGL or `webglcontextlost` shows the Entity_List and the message "3D rendering is unavailable" without mounting a canvas; reacts live to `prefers-reduced-motion` changes
    - _Requirements: 11.11, 11.14, 11.10, 18.8_

- [x] 5. Entity list, summary, announcer and progress
  - [x] 5.1 Implement accessibility helpers
    - Create `src/lib/a11y/summary.ts` (per-entity name, counts of low/medium/critical including zeros, related entity names; announcement helper capped at 250 characters) and `src/lib/a11y/contrast.ts` (WCAG ratio helper)
    - _Requirements: 18.3, 18.4, 18.7_
  - [x] 5.2 Build `EntityList`, `AutopsySummary`, `LiveAnnouncer`, `ProgressRail`
    - `EntityList` items are `<button>`s named `"{name}, {highest severity | no anomalies}"`, activated with Enter/Space to open the inspector
    - `AutopsySummary` always in the DOM; `LiveAnnouncer` context with one `aria-live="polite"` region; `ProgressRail` shows the five nodes with the current node name in its own `aria-live="polite"` region updated on each `started` event
    - Severity shown as icon plus text label (`ShieldAlert`/Critical, `TriangleAlert`/Medium, `Info`/Low)
    - _Requirements: 11.9, 18.3, 18.4, 18.5, 18.6, 10.10_
  - [x] 5.3 Write unit tests for summary, announcer and contrast
    - Cover zero counts, 250 character cap, accessible names, palette tokens meeting 4.5:1 (3:1 for large text) and focus color meeting 3:1
    - _Requirements: 18.2, 18.3, 18.4, 18.5, 18.7_

- [x] 6. Node_Inspector_Drawer
  - [x] 6.1 Build `NodeInspector.tsx`
    - shadcn `Sheet` (Radix Dialog) with title "Entity: {name}", a description element, focus to the close button on open, Escape closes and returns focus to the opener or the canvas wrapper `returnFocusRef`
    - Edit `components/ui/sheet.tsx` to animate with Framer Motion at 0.25 s and 0 s when `useReducedMotion()`
    - Show fields, at most 5 sample rows with "N corrupted rows in total", per-anomaly cards (icon plus label, confidence to two decimals, root cause), and "No anomalies were detected for this entity." when empty
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 11.8_
  - [x] 6.2 Write component tests for the inspector
    - Cover focus within 100 ms, Tab cycling, Escape focus return, dialog name and description, 5-sample cap, empty-anomaly message, reduced-motion duration
    - _Requirements: 13.2, 13.3, 13.4, 13.5, 13.7, 13.8_

- [x] 7. Vision X-Ray overlay
  - [x] 7.1 Build `VisionXRayOverlay.tsx`
    - Props `{ imageUrl, imageWidth, imageHeight, cells, defects, onAnnounce }`; shown only for image input; shadcn `Toggle` "Vision X-Ray" with `aria-pressed`, off by default; `aria-disabled="true"` plus a reason message when the image fails to load or there are no boxes
    - SVG with `viewBox="0 0 W H"` absolutely positioned over a `width:100%; height:auto` image; per cell a halo rect and a main rect (2 px, `vector-effect="non-scaling-stroke"`), green `#15803D` solid for confident cells, crimson dashed for confidence < 0.6 or any defect, `fill-opacity = round(0.1 + 0.5 * (1 - confidence), 2)`, text tags for flagged cells (cap 200), memoized rect group
    - Opacity legend, hover/focus tooltip (text, confidence to two decimals, defect type), flagged-region `<ul>` of focusable items whose Enter/Space highlights the rect, "No defects were detected." when empty, SVG `role="img"` with `aria-labelledby` the list heading, announcement "Vision X-Ray on. N flagged regions." from the toggle handler, no transition under reduced motion else 150 ms fade
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 18.1, 18.10, 18.11, 18.12, 18.13_
  - [x] 7.2 Write component tests for the overlay
    - Cover opacity formula, 0.6 boundary not flagged, list contents and ordering, disabled states, toggle `aria-pressed`, keyboard activation, announcement text
    - _Requirements: 12.2, 12.5, 12.6, 12.8, 12.9, 12.11, 18.10, 18.12_

- [x] 8. Search panel and generated code view
  - [x] 8.1 Build `SearchPanel.tsx`
    - Query input with 1–500 character validation, results list via `client.search`, "no records matched" message, result count announced in the polite region, hits dispatched to the reducer so the scene highlights the nodes
    - _Requirements: 14.3, 14.7, 14.10, 14.11_
  - [x] 8.2 Build `GeneratedCodeView.tsx`
    - Read-only code view of `resurrection.source` shown only when the syntax check passed, a download action saving the complete source as a single `.py` file, and the syntax error location display when it failed (source still shown)
    - _Requirements: 9.8, 9.10_
  - [x] 8.3 Write component tests for search and code view
    - Cover empty and over-length query rejection, no-match message, announcement, download content equals source
    - _Requirements: 14.7, 14.10, 14.11, 9.10_

- [ ] 9. Workbench assembly and web test suites
  - [x] 9.1 Assemble `AutopsyWorkbench.tsx` and `page.tsx`
    - Client container owning the reducer: wires Dropzone, client subscription (with reconnect and "connection lost" message keeping progress), ProgressRail, canvas, EntityList, summary, announcer, inspector, X-Ray (image input only), search panel and code view; announces result changes within 1 s
    - Shows the cache-served indicator and the uploaded image for image sessions
    - _Requirements: 1.9, 10.9, 10.10, 12.1, 15.5, 18.4, 19.8_
  - [-] 9.2 Write Playwright e2e tests against the mock
    - Cover keyboard-only flow, preset to results, X-Ray toggle, drawer, WebGL-disabled mode, zoom at 100/150/200% with `scrollWidth <= clientWidth`, and `@axe-core/playwright` with zero violations on empty, loaded text, loaded image with X-Ray on, open drawer and WebGL-unavailable states
    - _Requirements: 18.1, 18.2, 18.9, 11.11, 12.4, 18.8_
  - [~] 9.3 Write a Playwright rendering test for 5,000 points and 10,000 boxes
    - Assert the overlay shows within 1 s of toggling on with 10,000 boxes and record the frame rate for 50 nodes with 5,000 points
    - _Requirements: 12.13, 11.12_

- [~] 10. Checkpoint - Phase 1 complete
  - Ensure all tests pass (`pnpm --filter web exec tsc --noEmit`, lint, `vitest run`), ask the user if questions arise.

### Phase 2: FastAPI service

- [ ] 11. API foundation
  - [~] 11.1 Scaffold `apps/api`
    - Create `pyproject.toml` and pinned `requirements.txt` (FastAPI, pydantic v2, pydantic-settings, langgraph, httpx, redis, psycopg[binary,pool], pgvector, fastembed, opencv-python-headless, numpy, scikit-learn, paddleocr CPU, pytesseract, Jinja2; dev: pytest, pytest-asyncio, hypothesis, respx, fakeredis, ruff, mypy, import-linter)
    - Do not list `opencv-python`, `torch`, `nvidia-*` or `cuda*`
    - Create `app/` package layout and `tests/{unit,property,integration,contract}` with `tests/strategies.py`
    - _Requirements: 19.1, 19.13, 4.19, 4.20, 6.19_
  - [~] 11.2 Implement configuration and errors
    - `app/core/config.py` (`Settings` with `SecretStr`): start-fatal `WEB_ORIGIN`, `REDIS_URL`, `SUPABASE_DB_URL` naming the missing variable without printing values; optional provider keys; `OCR_ENGINE` default `paddleocr` with one warning on invalid value; `CACHE_TTL_SECONDS` 60–604,800 default 86,400 with a warning; `SANITIZER_MAX_CHARS` 1–100,000 default 10,000; `MAX_CONCURRENT_SESSIONS`
    - `app/core/errors.py` with `ErrorResponse` handlers: Pydantic `RequestValidationError` becomes `422 validation_error` listing failed fields with no state change and no echoed values; unhandled errors become `500 internal_error` with a correlation ID
    - _Requirements: 17.5, 17.6, 17.8, 17.9, 4.6, 15.4, 15.8, 8.5_
  - [~] 11.3 Implement logging with redaction
    - `app/core/logging.py`: filter dropping `extra` fields named `payload`, `content`, `text`, `bytes` and masking configured secret values; log only session ID, node, duration, sizes and codes
    - _Requirements: 17.11, 8.6_
  - [~] 11.4 Write property test for log hygiene
    - **Property 18: Log hygiene**
    - Canary strings in file content, OCR text and credentials never appear in any log record at any level (run once the pipeline exists in task 22; placed here with the logging code and extended there)
    - **Validates: Requirements 17.11, 8.6**
  - [~] 11.5 Implement wire schemas
    - `app/schemas/autopsy.py` with every Pydantic model from the design (`Wire` base with `extra="forbid", frozen=True`, `Score` with 2 dp rounding validator, `BoundingBox`, `VisionCell`, `VisionDefect`, `VisionResult`, `SchemaField`, `PrimaryKey`, `ForeignKey`, `Entity`, `SchemaResult`, `RawPreview`, `Anomaly`, `SpatialPoint`, `MlResult`, `RotResult`, `ResurrectionResult`, `SessionEvent`, `SearchRequest`, `SearchHit`, `SearchResponse`, `ErrorResponse`) and per-node payload model lookup
    - _Requirements: 17.5, 4.11, 5.4, 7.5, 7.6, 10.2, 14.5_
  - [~] 11.6 Implement EventLog and SessionStore
    - `app/services/sessions.py`: `EventLog.append` assigns strictly increasing IDs from 1 under an `asyncio.Lock` and validates the payload against the model for `(type, node, state)`; `subscribe(after_id)` snapshots `events[after_id:]` then waits on an `asyncio.Condition`; in-process `SessionStore` with the `index_key`, retention of 7,200 s, `fold_events()` producing the snapshot
    - _Requirements: 10.1, 10.2, 10.4, 10.8, 14.8_
  - [~] 11.7 Write property test for SSE ordering and replay
    - **Property 12: SSE ordering and replay**
    - Include reconnect points `k` in `[0, n]`, concurrent appends during replay, and the web `sse-client` parsing arbitrary chunk splits of the same byte stream (a fast-check test in `apps/web/src/lib/sse-client.property.test.ts`)
    - **Validates: Requirements 10.2, 10.4, 10.8, 15.5**

- [ ] 12. Upload checks and sanitizer
  - [~] 12.1 Implement `file_checks.py`
    - Streaming 64 KiB chunk read aborting past 10,485,760 bytes; case-insensitive extension allow-list; per-kind size cap (`>` rejects); executable magic bytes (ELF, MZ, Mach-O variants, `CA FE BA BE`); signature versus extension (PNG, JPEG, text must not start with either); PNG/JPEG header dimension reader for the decompression-bomb guard
    - Return typed errors mapped to `413 file_too_large`, `415 unsupported_extension`, `415 binary_executable`, `415 signature_mismatch`
    - _Requirements: 1.1, 1.2, 1.7, 1.8, 1.11, 4.3_
  - [~] 12.2 Write property test for the upload gate
    - **Property 15: Upload gate**
    - Accept iff extension allowed, size within the kind's limit (limit passes, limit+1 fails), no executable prefix, and prefix matches extension rules; rejection creates no session; frontend `file-validation.ts` and the API agree on shared cases via a shared JSON case table
    - **Validates: Requirements 1.1, 1.2, 1.5, 1.6, 1.7, 1.8, 1.11**
  - [~] 12.3 Implement the sanitizer
    - `app/services/sanitizer.py`: `sanitize_value` (drop `Cc` except `\n`/`\t`, truncate to `max_len`, replace `<` runs of three or more with `‹` one for one), `wrap_data` with per-request nonce delimiters, `sanitize_cell` (controls removed, 1,000 chars)
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 4.10_
  - [~] 12.4 Write property test for the sanitizer
    - **Property 11: Sanitizer**
    - Output has no `Cc` except `\n`/`\t`, length within `max_len`, no `<<<`, the end delimiter appears exactly once and last, instruction-like text without controls or `<<<` is unchanged, `sanitize_cell` truncates to 1,000
    - **Validates: Requirements 4.10, 17.1, 17.2, 17.3, 17.4**

- [ ] 13. Legacy parser
  - [~] 13.1 Implement `parser.py`
    - `Layout`, `ParseResult`, `parse(data, hints=None)` and `print_records(records, layout)`: encoding detection (ascii, utf-8, EBCDIC share with 0.5 threshold, cp037 decode with U+FFFD, uncertain flag), line delimiter detection (LF/CRLF/CR/FIXED with record-length search), CSV delimiter and header detection, fixed-width boundaries (at most 100, ascending byte offsets), per-record failures recorded as `(line, reason)` and excluded, preview of the first 50 records, right-trim only, RFC 4180 quoting, `cp037` output for EBCDIC
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10_
  - [~] 13.2 Write property test for the legacy record round trip
    - **Property 1: Legacy record round trip**
    - `parse(print_records(R, L), hints=L)` yields `R` for LF, CRLF, CR, FIXED and the four CSV delimiters, in ASCII, UTF-8 and cp037
    - **Validates: Requirements 2.1, 2.5, 2.6, 2.8, 2.9**
  - [~] 13.3 Write property test for parser determinism and bounds
    - **Property 2: Parser determinism and bounds**
    - Equal results on identical bytes, confidence in [0, 1], strictly ascending boundaries with at most 100 entries, preview of `min(50, n)` records, failed records excluded and reported with 1-based lines
    - **Validates: Requirements 2.1, 2.2, 2.4, 2.5, 2.7, 2.10**

- [ ] 14. Copybook parser
  - [~] 14.1 Implement `copybook.py`
    - Tokenizer plus recursive-descent parser for fixed and free format; levels 01–49, 66, 77, 88; names 1–30 chars; PIC (canonical form), USAGE (DISPLAY, COMP, COMPUTATIONAL, BINARY, COMP-3, PACKED-DECIMAL, COMP-1, COMP-2, COMP-5), OCCURS 1–9,999, REDEFINES; storage sizes per the design, zero-based offsets, group lengths, record length excluding redefining fields; `print_copybook`
    - `CopybookError(line, text)` for unsupported constructs with no partial layout, and the no-layout error for empty input (code `copybook_no_layout`)
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.7, 3.8_
  - [~] 14.2 Write property test for the copybook round trip
    - **Property 3: Copybook round trip**
    - `parse_copybook(print_copybook(L)) == L` including offsets and lengths; REDEFINES offset equals target offset; record length equals sum of non-redefining lengths
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.8, 3.9**
  - [~] 14.3 Write property test for atomic copybook failure
    - **Property 4: Copybook failure is atomic**
    - Inputs with an unsupported construct raise `CopybookError` with the right 1-based line and construct text and return no layout; empty input raises the no-layout error
    - **Validates: Requirements 3.6, 3.7**

- [ ] 15. LLM router
  - [~] 15.1 Implement `core/llm.py`
    - `LLMRequest`, `LLMResult`, `ProviderFailure`/`ProviderAttempt`, `LLMRouter.has_provider()` and `complete()`: ILMU first (OpenAI-compatible `chat/completions` with `image_url` data URIs, 30 s `httpx` timeout), on error, timeout or structured-output failure emit the fallback event through the `EventSink` then call Claude immediately (Anthropic Messages API, 30 s), no retries, double failure raises `ProviderFailure` naming both providers and reasons with no credential or body content; disabled providers (missing key) skipped with a configuration error naming the variable; provider recorded on results; image requests follow the same order
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 4.9_
  - [~] 15.2 Write property test for router ordering
    - **Property 17: Router ordering**
    - Over all ILMU/Claude outcome combinations (ok, HTTP error, timeout, invalid structure) with `respx`: ILMU first, Claude at most once and only after an ILMU failure with the fallback event emitted before the Claude request, double failure names both providers, no credential string appears in messages, events or logs
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6, 8.7**

- [ ] 16. Vision services
  - [~] 16.1 Implement `services/vision.py` (process-pool safe, pure)
    - Header-based size checks (width/height at least 200, at most 40,000,000 pixels), deskew with angle clamped to ±45 and rounded to 0.1, CLAHE (clip 2.0, 8x8), Gaussian adaptive threshold, morphological table-grid detection with open-side detection, row/column clustering, 10,000-cell cap checked before OCR, per-cell OCR with engine selection and failover (PaddleOCR recognition-only, Tesseract `--psm 7`), inverse-deskew box mapping clamped into the original image with width and height at least 1, confidence rounded to two decimals, `smudged = confidence < 0.6`, and `smudged_digit`, `torn_total`, `misaligned_column` defect rules
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.11, 4.12, 4.13, 4.15, 4.19, 4.20_
  - [~] 16.2 Write property test for vision geometry
    - **Property 16: Vision geometry**
    - Synthetic skewed table images (angles -45..45): every box inside the original image with width and height at least 1, rows ordered top to bottom from 1, cells left to right, `smudged` equals `confidence < 0.6`
    - **Validates: Requirements 4.4, 4.5, 4.11, 4.12**
  - [~] 16.3 Implement the vision-LLM fallback helper
    - Re-encode the decoded array with `cv2.imencode` (drops EXIF), downscale to at most 1568 px on the long edge, call the router once with the `VisionTable` response model, scale boxes back, reject boxes outside the image as validation failures, sanitize returned text with `sanitize_cell`
    - _Requirements: 4.8, 4.9, 4.10, 8.8_

- [ ] 17. ML services
  - [~] 17.1 Implement `services/ml.py` (process-pool safe)
    - Per entity: numeric columns (integer/decimal), median imputation, drop constant columns, byte-length variance feature, skip rules (`insufficient_rows` under 20 rows, `no_numeric_columns`, `constant_features`), `IsolationForest(contamination="auto", random_state=42)` with `decision_function` rounded to 6 dp, outlier iff score < -0.15, `StandardScaler` + `PCA(n_components=min(3, nonconstant), svd_solver="full", random_state=42)`, zero padding, per-axis max-abs normalization, one `statistical_outlier` anomaly per entity with the highest mean absolute z-score field, sampling of at most 5,000 points (flagged first, then uniform stride)
    - No import of `core.llm`; add an import-linter contract in `pyproject.toml` enforcing it
    - _Requirements: 6.2, 6.3, 6.4, 6.6, 6.7, 6.11, 6.13, 6.14, 6.16, 6.17, 6.18, 6.19_
  - [~] 17.2 Write property test for ML determinism and geometry
    - **Property 8: ML scoring determinism and geometry**
    - Equal scores and coordinates at 6 dp on repeated runs, coordinates finite in [-1, 1], flagged iff score < -0.15 (boundary -0.15 not flagged), one triple per row, all-zero axis gives 0.0, fewer than 3 non-constant dimensions pads zeros, skip rules give the specified reasons
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.13, 6.14, 6.15, 6.16**

- [ ] 18. Code generation and persistence services
  - [~] 18.1 Implement `services/codegen.py`
    - Jinja2 template; `safe_identifier()` (non-identifier chars to `_`, `f_` prefix for leading digit, `_` suffix for keywords and `BaseModel` attributes, numeric de-duplication); one Pydantic v2 model and one `APIRouter` with exactly five endpoints per entity over an in-memory dict; type-mapped `Annotated[..., Field(max_length/max_digits/pattern)]` plus `json_schema_extra={"legacy_length": n}`; one `# {anomaly} ({severity})` comment per anomaly above its field; `ast.parse` syntax check returning line, offset and message; never executes the source; zero entities yields only `app = FastAPI()`
    - _Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 17.14_
  - [~] 18.2 Write property test for generated code
    - **Property 13: Generated code compiles**
    - Entity and field names with quotes, newlines, keywords, leading digits, duplicates and Unicode: `ast.parse` passes, exactly one model and one router with five route decorators per entity, `legacy_length` equals the inferred length, one comment per anomaly, verified by AST walk without importing
    - **Validates: Requirements 9.3, 9.4, 9.5, 9.6, 9.7, 17.14**
  - [~] 18.3 Implement `services/cache.py`
    - Key `necro:result:{sha256}` (single file: raw bytes hashed before decode; data plus copybook: length-prefixed hash); value `gzip(json({"v": 1, "input_kind", "events"}))`; the only `SET` call site uses `EX ttl`; `redis.asyncio` with 2 s timeouts; get failures treated as a miss with one warning, set failures log a warning; nothing stored for failed or cancelled sessions
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8, 15.9_
  - [~] 18.4 Write property test for the cache round trip
    - **Property 10: Cache round trip**
    - `decode(encode(x)) == x`, `fakeredis` set/get preserves events in order with original types and payloads, every key has a TTL in [60, 604800], invalid TTL settings fall back to 86,400, key equality tracks byte equality
    - **Validates: Requirements 15.1, 15.4, 15.5, 15.7, 15.8**
  - [~] 18.5 Implement `services/vector_store.py`
    - `ensure_schema()` (extension, `record_embeddings` table, session btree index, RLS), `AsyncConnectionPool(min_size=1, max_size=5, timeout=3)` with `prepare_threshold=None`, `index_session` embedding with `fastembed` `BAAI/bge-small-en-v1.5` in batches of 256 on a worker thread with a 120 s deadline checked between batches, upserts in batches of 1,000 with bound parameters, `empty_fields` and `anomaly_flags`, hourly purge task
    - `search`: missing-field intent regex and field-token matching adding `empty_fields @> %s`, cosine query with bound parameters, `LIMIT 100`, similarity clamped to [0, 1] and `SEARCH_MIN_SIMILARITY` of 0.35, `asyncio.timeout(4.5)` with `statement_timeout=4000ms`; `index_key` always comes from the session store
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 17.13_
  - [~] 18.6 Write property test for search isolation
    - **Property 14: Search session isolation**
    - With multiple sessions in one table (pgvector test container or a faithful in-memory fake store) and SQL metacharacter queries: every hit belongs to the requesting session key, missing-field queries return no hit with a non-empty matched field, at most 100 hits in non-increasing similarity, invalid lengths rejected with no hits
    - **Validates: Requirements 14.3, 14.5, 14.6, 14.8, 14.11, 17.13**

- [~] 19. Checkpoint - Services complete
  - Ensure all tests pass (`pytest apps/api/tests/unit apps/api/tests/property`, `ruff`, `mypy`, import-linter), ask the user if questions arise.

- [ ] 20. LangGraph state, graph and the first three nodes
  - [~] 20.1 Implement state and graph skeleton
    - `app/agents/state.py` (`AutopsyState`, merge for `node_status`); `app/agents/graph.py` with `StateGraph`, the `instrument(name)` wrapper emitting `started`, `completed`, `failed`, `skipped` through `EventLog` only, `route` node (text: emit `vision_extractor` skipped `text_input` first; image: vision first), conditional edges to `END` on failure, `skip_resurrector` node, and a 600 s session guard
    - _Requirements: 4.1, 4.2, 5.1, 5.2, 9.9, 10.2, 10.4, 10.5, 10.11_
  - [~] 20.2 Implement the `vision_extractor` node
    - `app/agents/nodes/vision_extractor.py`: run `services/vision.py` in a `ProcessPoolExecutor` with 45 s local budget (recycle pool on timeout and route to the LLM fallback as if both engines failed), fallback conditions (both engines fail, mean confidence < 0.4, grid < 2x2), 120 s node limit, failure codes `unreadable_image`, `no_table_detected`, `cell_limit_exceeded`, `vision_timeout`, `sanitize_cell` on all text, completion payload with rows, boxes, defects, skew angle and engine
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.8, 4.10, 4.14, 4.15, 4.16, 4.17, 4.18_
  - [~] 20.3 Implement the `schema_archaeologist` node
    - `app/agents/nodes/archaeologist.py`: parse (copybook first when supplied), entity detection (copybook 01 records, record-type discriminator, filename stem), field boundaries from copybook or parser, names (`"{type}_{position}"` unique), narrowest type at 95% match with `type_confidence`, role table, primary key (uniqueness x completeness, none gives `field=None` and 0.0), foreign keys by containment at least 0.9, image input using grid column index as position, optional LLM assist validated by Pydantic with deterministic values kept, `RawPreview` for text, `SchemaResult` validation failure marks the node failed listing invalid fields
    - _Requirements: 2.7, 3.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_
  - [~] 20.4 Implement the `ml_rot_scorer` node
    - `app/agents/nodes/ml_rot_scorer.py`: run `services/ml.py` in a process pool with a 30 s limit; whole-node `skipped` with reasons when every entity is skipped; sklearn exception gives `skipped(scoring_error)` and timeout gives `skipped(timeout)` discarding partial results; completion payload with anomalies, skipped entities and at most 5,000 points
    - _Requirements: 6.1, 6.8, 6.9, 6.10, 6.17, 6.18_

- [ ] 21. rot_detector and api_resurrector nodes
  - [~] 21.1 Implement the `rot_detector` node
    - `app/agents/nodes/rot_detector.py`: deterministic checks (`orphan_foreign_key`, `negative_stock`, `negative_ledger_balance`, `truncated_field`, `byte_offset_overflow` with record number, actual and expected lengths, `duplicate_ledger_entry`); ML anomalies copied unchanged and classified (low if lowest score >= -0.30 else medium, confidence `round(min(1, -min/0.5), 2)`); critical for orphan FK, overflow and negative inventory with no downgrade; semantic checks within `asyncio.timeout(60)` for the 10 lowest-score rows and up to 10 orphan FKs, accepted only with rows subset of input, name `semantic_corruption`, severity at most medium; at most 5 samples; fixed template root cause for unexplained outliers; degradation when no provider or router failure; empty list for zero rows; final row-subset assertion
    - _Requirements: 3.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12_
  - [~] 21.2 Write property test for the affected-rows subset invariant
    - **Property 5: Affected-rows subset invariant**
    - For `ml_rot_scorer` and `rot_detector` outputs including LLM anomalies from a stub router returning arbitrary row numbers: `affected_rows` is a subset of input rows and `sample_rows` is a subset of `affected_rows` with length at most 5
    - **Validates: Requirements 6.12, 7.6, 7.12**
  - [~] 21.3 Write property test for severity classification
    - **Property 7: Severity classification**
    - Orphan FK, byte-offset overflow, negative stock and negative ledger balance are always critical even if a stub LLM asks for low; `statistical_outlier` is low iff lowest score >= -0.30, never critical, confidence matches the formula; each anomaly has exactly one severity
    - **Validates: Requirements 7.5, 7.7, 7.8**
  - [~] 21.4 Write property test for deterministic rot rules
    - **Property 9: Deterministic rot rules**
    - Injected orphan FK, negative stock, negative balance, byte-length mismatch and duplicate each produce the matching anomaly; clean datasets produce none; zero rows yields an empty list without error
    - **Validates: Requirements 3.5, 7.2, 7.11**
  - [~] 21.5 Implement the `api_resurrector` node
    - `app/agents/nodes/resurrector.py`: indexing stage first (`vector_store.index_session`, failure recorded as `indexing = {status: "failed", reason}` and generation continues), then `codegen` with syntax check; syntax failure marks the node failed with line, offset and message within 2 s and keeps the source; completion payload with source, `syntax_ok`, indexing status and model names
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.8, 14.1, 14.2_
  - [~] 21.6 Wire all nodes into the graph
    - Register the five nodes and `skip_resurrector` in `graph.py` with the edges from the design (rot_detector failure skips api_resurrector, ml_rot_scorer never sets `failure`), per-node timeouts from the design table
    - _Requirements: 4.1, 5.1, 6.1, 7.1, 9.1, 9.9, 10.11_
  - [~] 21.7 Write property test for score ranges
    - **Property 6: Score ranges**
    - Over pipeline outputs on generated datasets and stubbed vision results, every Confidence_Score (types, keys, anomalies, OCR cells, defects, encoding, search similarity) lies in [0, 1] with at most 2 decimals where specified, and the models reject out-of-range values
    - **Validates: Requirements 2.2, 4.11, 5.4, 7.5, 14.5**
  - [~] 21.8 Write integration tests for the pipeline
    - Run each Preset through the graph with stubbed ILMU/Claude (`respx`), `fakeredis` and a fake vector store; assert event order, text session first event `vision_extractor skipped text_input`, image session with a generated skewed table, a failing node ends with `error` then `terminal`, indexing failure still generates code, process-pool timeouts (patched short) recycle the pool, and extend Property 18 over a full run
    - _Requirements: 4.2, 5.1, 6.8, 9.2, 10.5, 10.11, 14.2, 17.11_

- [ ] 22. Sessions, routes, presets and app wiring
  - [~] 22.1 Implement sessions routes
    - `app/routes/sessions.py`: `POST /api/sessions` (multipart `file` and optional `.cpy` `copybook`, upload processing order from the design, hash, cache lookup, session creation within 2 s, background task guarded by `asyncio.Semaphore(MAX_CONCURRENT_SESSIONS)` with a queue cap of 10 giving `503 busy`), `POST /api/sessions/preset`, `GET /api/sessions/{id}/events` (SSE frames, `Last-Event-ID` header or `last_event_id` query validated as an integer in `[0, last_id]`, `X-Necro-Cache`, 15 s keepalive, terminal flush and close, replay), `GET /api/sessions/{id}`, `GET /api/sessions/{id}/anomalies` with severity and entity filters; cached sessions preload the event log and set `served_from_cache`; success caches only completed sessions
    - _Requirements: 1.7, 1.8, 1.11, 1.12, 10.1, 10.6, 10.8, 15.1, 15.2, 15.3, 15.5, 15.9, 16.2, 17.5, 17.6_
  - [~] 22.2 Implement search, presets and health routes
    - `app/routes/search.py` (`POST /api/sessions/{id}/search`: 422 `invalid_query` for empty, whitespace-only or over 500 characters, 409 `not_indexed`, 503 `search_unavailable` within 5 s, session-restricted via `index_key`), `app/services/presets.py` and `app/routes/presets.py` (`GET /api/presets`, `GET /api/presets/{id}/image`), `app/routes/health.py`
    - _Requirements: 14.3, 14.7, 14.8, 14.9, 14.11, 14.12, 1.3, 4.2_
  - [~] 22.3 Implement `main.py` wiring
    - FastAPI lifespan (settings, `ensure_schema`, Redis, router, process pool, purge task), `CORSMiddleware` with exactly `WEB_ORIGIN`, methods GET/POST, headers `Content-Type`, `Last-Event-ID`, `Authorization`, exposed `X-Necro-Cache`, no wildcard, optional constant-time bearer check when `API_TOKEN` is set and `Authorization` is present, error handlers from task 11.2
    - _Requirements: 17.5, 17.9, 17.12, 8.5_
  - [~] 22.4 Write API integration tests
    - `TestClient` with `fakeredis` and fake store: cache hit replays identical events with the cached indicator, SSE reconnect with `Last-Event-ID`, invalid `Last-Event-ID` gives 400, search before indexing gives 409, "Show all warehouse transfers with missing branch codes" on the F&B preset returns only empty-branch records, Redis down still completes a session, validation errors list fields without side effects, CORS rejects other origins, cached first byte under 300 ms for a 10 MB payload
    - _Requirements: 14.6, 14.12, 15.2, 15.3, 15.5, 15.6, 10.8, 17.6, 17.12_
  - [~] 22.5 Write the OpenAPI and TypeScript contract test
    - Dump `app.openapi()`, convert with `json-schema-to-typescript`, and add a `tsc` file asserting mutual assignability with `apps/web/src/types/autopsy.ts`; validate the mock event stream against the Pydantic `SessionEvent` models
    - _Requirements: 19.9_

- [ ] 23. Container and local environment
  - [~] 23.1 Write the root `Dockerfile`
    - Repo-root build context (copies `sample-dumps/`), Python 3.12 slim, Tesseract, `opencv-python-headless` only, no PyTorch or CUDA, `fastembed` model weights downloaded at build time, uvicorn entrypoint
    - Add `scripts/check_image_size.sh` failing and printing the measured size when the built image is at or above 1,200,000,000 bytes; if PaddleOCR pushes the image over the limit, move it to an optional extra and default the image's `OCR_ENGINE` to `tesseract`
    - _Requirements: 4.19, 4.20, 4.21, 19.12_
  - [~] 23.2 Write `docker-compose.yml`
    - Services `api`, `redis` and `pgvector/pgvector:pg16` for local development with env vars from `.env`
    - _Requirements: 14.1, 15.1, 17.8_

- [ ] 24. Replace Mock_Data with the HTTP client
  - [~] 24.1 Implement `HttpClient` and switch the factory
    - Add `HttpClient` to `src/lib/api-client.ts` implementing `AutopsyClient` with multipart upload, `POST /api/sessions/preset`, `openSessionStream` for `subscribe`, `search`, `getAnomalies`, `presetImageUrl`; `createClient()` returns it unless `NEXT_PUBLIC_USE_MOCK === "true"`; do not edit `src/types/autopsy.ts`
    - Use `NEXT_PUBLIC_API_URL`; surface `ErrorResponse` codes as dropzone alerts
    - _Requirements: 19.9, 1.9, 1.12, 1.13, 10.7_
  - [~] 24.2 Write unit tests for `HttpClient`
    - Mock `fetch`: multipart body, 10 s abort, error mapping, search request shape
    - _Requirements: 1.13, 14.3, 19.9_
  - [~] 24.3 Add Playwright e2e against docker-compose
    - Upload, preset, keyboard-only flow, X-Ray toggle with a real image preset, SSE reconnect by killing the stream
    - _Requirements: 10.7, 10.9, 12.3, 1.10_

- [~] 25. Checkpoint - Phase 2 complete
  - Ensure all tests pass (`pytest apps/api`, `ruff`, `mypy`, import-linter, web `tsc --noEmit` and `vitest run`), ask the user if questions arise.

### Phase 3: MCP server, CI and repository checks

- [ ] 26. Kiro MCP server
  - [~] 26.1 Scaffold `packages/mcp-server`
    - `package.json` (TypeScript, Node 20, `@modelcontextprotocol/sdk`, `ajv`, Vitest, fast-check), `tsconfig.json`, `src/{index.ts,tools.ts,schemas.ts,api.ts,file-checks.ts,types.ts}`
    - _Requirements: 19.1, 16.3_
  - [~] 26.2 Implement schemas and file checks
    - `schemas.ts` with the two JSON Schemas from the design compiled by `ajv` (`allErrors: true`) and published verbatim; `file-checks.ts` with stat (regular file only), extension, size limits (`>` comparison) and image signature checks
    - _Requirements: 16.3, 16.4, 16.5, 16.6, 16.7_
  - [~] 26.3 Implement the API client and tools
    - `api.ts`: env check on every call (`NECRO_API_URL`, `NECRO_API_TOKEN`, naming the missing one, no request), 30 s timeout, bearer header, `api_unavailable` mapping
    - `tools.ts`: `inspect_legacy_schema` (validate, file checks before upload, POST session, poll every 1 s until completed/failed or `MCP_ANALYSIS_TIMEOUT_MS` default 300,000, return schema with confidences, anomaly counts, failure node and code, `analysis_incomplete` with session ID on timeout) and `query_rot_anomalies` (AND filters via `GET /api/sessions/{id}/anomalies`, 404 mapped to "session not found"); all errors use `isError: true` with `{error: {code, message, parameters?}}`
    - _Requirements: 16.1, 16.2, 16.8, 16.9, 16.10, 16.11, 17.8_
  - [~] 26.4 Implement the stdio server entry
    - `index.ts` low-level `Server` with `ListTools` and `CallTool`; starts even when env variables are missing, logging the variable name to stderr and returning the 16.11 error per call
    - _Requirements: 16.3, 16.11, 17.9_
  - [~] 26.5 Write MCP unit and property tests
    - fast-check over invalid inputs naming every invalid parameter with no `fetch` call; size, signature and missing-env rejections with no `fetch`; 404 mapping; 30 s timeout with fake timers; filter semantics
    - _Requirements: 16.2, 16.4, 16.5, 16.6, 16.7, 16.8, 16.10, 16.11_

- [ ] 27. Repository checks, CI and documentation
  - [~] 27.1 Implement repository check scripts
    - `scripts/check_manifests.py` (fails and reports manifest and package for `opencv-python`, `torch`, `nvidia-*`, `cuda*`; requires `opencv-python-headless`), `scripts/check_presets.py` (Luhn-valid card numbers, email, phone and SSN patterns reported by file name; PNG EXIF and `tEXt/iTXt/zTXt` chunks; runs the vision extractor on the PNG and scans its text; checks the PNG is valid, at most 10 MB and at least 1,000 px wide), and a `.kiro` check that no `.gitignore` pattern ignores any file under `.kiro`
    - _Requirements: 19.5, 19.10, 19.11, 19.13, 19.3_
  - [~] 27.2 Write unit tests for the repository checks
    - Positive and negative fixtures for each check (a Luhn-valid number, a forbidden package, an ignored `.kiro` path)
    - _Requirements: 19.5, 19.11, 19.13_
  - [~] 27.3 Write the CI workflow
    - `.github/workflows/ci.yml` jobs: `web` (pnpm install, `tsc --noEmit`, lint, Vitest, build, Playwright), `api` (ruff, mypy, pytest with Postgres and Redis services, import-linter), `mcp` (tsc, Vitest), `contract` (OpenAPI vs types), `repo-checks` (manifests, presets, `.kiro` ignore, gitleaks, README variable check), `image` (build, size gate, smoke test)
    - _Requirements: 19.12, 19.13, 17.7, 4.21_
  - [~] 27.4 Write the README and verify LICENSE
    - `README.md` with project overview, monorepo layout, local run steps, the environment variable table (name, purpose, required or optional for Vercel and Railway, no secret values, including `OCR_ENGINE`), and a Kiro `mcp.json` example for the MCP server
    - Confirm `LICENSE` is the MIT text naming a copyright holder and year and fix it if not
    - Add a script run in CI that fails when a `Settings` field is not documented in the README table
    - _Requirements: 19.6, 19.7, 17.10_
  - [~] 27.5 Write a test for the README variable check
    - Fails when a `Settings` field is missing from the table and passes when all are present
    - _Requirements: 19.7_

- [~] 28. Final checkpoint - Everything wired and passing
  - Ensure all tests pass across web, API, MCP and repository checks, and that the delivery order in the task list satisfies Requirement 19.8, ask the user if questions arise.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "2.2", "4.1", "5.1"] },
    { "id": 3, "tasks": ["2.3", "2.4", "2.6", "4.2", "4.3", "5.3"] },
    { "id": 4, "tasks": ["2.5", "2.7", "2.8", "4.4", "4.5", "5.2"] },
    { "id": 5, "tasks": ["2.9", "3.1", "6.1", "7.1", "8.1", "8.2"] },
    { "id": 6, "tasks": ["3.2", "6.2", "7.2", "8.3", "9.1"] },
    { "id": 7, "tasks": ["9.2", "9.3"] },
    { "id": 8, "tasks": ["11.1"] },
    { "id": 9, "tasks": ["11.2", "11.5"] },
    { "id": 10, "tasks": ["11.3", "11.6", "12.1", "12.3", "13.1", "14.1", "16.1", "17.1", "18.1", "18.3", "18.5"] },
    { "id": 11, "tasks": ["11.4", "11.7", "12.2", "12.4", "13.2", "13.3", "14.2", "14.3", "15.1", "16.2", "17.2", "18.2", "18.4", "18.6"] },
    { "id": 12, "tasks": ["15.2", "16.3"] },
    { "id": 13, "tasks": ["20.1"] },
    { "id": 14, "tasks": ["20.2", "20.3", "20.4", "21.1", "21.5"] },
    { "id": 15, "tasks": ["21.2", "21.3", "21.4", "21.6"] },
    { "id": 16, "tasks": ["21.7", "21.8", "22.1", "22.2", "23.1"] },
    { "id": 17, "tasks": ["22.3", "23.2"] },
    { "id": 18, "tasks": ["22.4", "22.5", "24.1"] },
    { "id": 19, "tasks": ["24.2", "24.3"] },
    { "id": 20, "tasks": ["26.1", "27.1"] },
    { "id": 21, "tasks": ["26.2", "27.2", "27.4"] },
    { "id": 22, "tasks": ["26.3", "27.3", "27.5"] },
    { "id": 23, "tasks": ["26.4", "26.5"] }
  ]
}
```

## Notes
- Tasks marked with `*` are optional and can be skipped for a faster MVP.
- Each property-test sub-task carries one Correctness Property from design.md (1 to 18), placed right after the code it tests. Properties 6 and 18 are first written where their code is introduced and extended once the full pipeline exists (tasks 21.7 and 21.8).
- Task order follows Requirement 19.8: web with Mock_Data, then API with SSE, then MCP.
- The design defines no steering files or hooks, so none are planned. Deployment and production performance measurement are out of scope; performance checks appear only as automated tests.
- Open design assumption: ILMU is assumed to expose an OpenAI-compatible `chat/completions` endpoint. Confirm it before task 15.1; only `core/llm.py` changes if it is wrong.
