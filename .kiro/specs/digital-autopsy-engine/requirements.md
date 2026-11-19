# Requirements Document

## Introduction

NecroLegacy is a "Digital Autopsy" workbench. It ingests 1980s-era mainframe fixed-width dumps, COBOL copybooks, legacy POS/logistics batch files, and scanned or photographed paper records (invoices, CRT screen photos and dot-matrix manifests), and runs them through a five-node LangGraph multi-agent forensic pipeline. A computer-vision layer (OpenCV preprocessing, table-grid detection and OCR with a vision-LLM fallback) turns images into structured rows. A machine-learning layer (scikit-learn IsolationForest and PCA over record embeddings) flags statistical outliers and computes 3D coordinates before any LLM sees the data. The pipeline infers the hidden schema, detects silent data rot, and synthesizes modern FastAPI REST wrappers. Results appear in an interactive Three.js 3D anatomical visualizer, and a "Vision X-Ray" overlay shows where image cells were read with low confidence or defects were detected. Records are embedded in Supabase pgvector for natural-language forensic queries, Redis caches completed analyses for replay, and a Kiro MCP server exposes the engine to Kiro IDE.

The system is a monorepo: `apps/web` (Next.js 15, deployed as a Render static site), `apps/api` (FastAPI, deployed on Railway), `packages/mcp-server`, and `sample-dumps/`. Development proceeds UI-first with typed mock data, then API and SSE, then MCP.

## Glossary

- **NecroLegacy**: The overall product comprising Web_App, API_Service, and MCP_Server.
- **Web_App**: The Next.js 15 frontend in `apps/web`.
- **Necro_Dropzone**: The Web_App component that accepts file uploads and preset selection.
- **Autopsy_Table**: The Three.js and Framer Motion 3D scene in the Web_App that renders inferred entities and relationships.
- **Node_Inspector_Drawer**: The shadcn/ui slide-over panel showing forensic details for one entity.
- **Entity_List**: The keyboard-navigable, screen-reader-accessible list of entities that mirrors the Autopsy_Table.
- **API_Service**: The FastAPI backend in `apps/api`.
- **Legacy_Parser**: The deterministic API_Service component that detects format, delimiters, encoding and field boundaries of text input.
- **Copybook_Parser**: The deterministic API_Service component that parses COBOL copybook (`.cpy`) definitions.
- **Forensic_Stitcher**: The LangGraph StateGraph in the API_Service that runs vision_extractor, schema_archaeologist, ml_rot_scorer, rot_detector and api_resurrector in order (5 nodes).
- **vision_extractor**: Forensic_Stitcher node 1; runs only for image input; applies OpenCV deskew, CLAHE contrast enhancement, adaptive thresholding and table-grid contour detection, then OCR (PaddleOCR or Tesseract, with a vision-LLM fallback), and produces Bounding_Boxes, per-cell text, per-cell Confidence_Scores and structured rows.
- **schema_archaeologist**: Forensic_Stitcher node 2; infers column boundaries, types, candidate primary keys and implicit foreign keys from parsed text records or from the rows extracted by the vision_extractor.
- **ml_rot_scorer**: Forensic_Stitcher node 3; computes one Record_Embedding per record, runs a scikit-learn IsolationForest over numeric columns to flag statistical outliers, and runs a PCA over the Record_Embeddings to compute Spatial_Coordinates for each record, falling back to a PCA over the numeric columns when embeddings are unavailable.
- **rot_detector**: Forensic_Stitcher node 4; runs deterministic Pydantic validation checks, consumes the ML outliers from the ml_rot_scorer, and runs semantic LLM checks that explain the top ML anomalies and referential breaks.
- **api_resurrector**: Forensic_Stitcher node 5; indexes records in the Vector_Store and generates Pydantic v2 models and FastAPI CRUD routers.
- **LLM_Router**: The API_Service component that sends LLM requests, including vision-LLM image requests, to the Primary_Model first and to the Fallback_Model as fallback, through one LLM_Transport.
- **LLM_Transport**: The API the LLM_Router calls, selected by the environment variable LLM_PROVIDER: "bedrock" (default; the Amazon Bedrock Converse API authenticated with AWS SigV4 from the standard AWS credential chain) or "openai_compatible" (any OpenAI-compatible `/chat/completions` endpoint at LLM_BASE_URL with LLM_API_KEY).
- **Primary_Model**: The open-weight model the LLM_Router tries first, named by LLM_PRIMARY_MODEL (default `openai.gpt-oss-120b-1:0` on Amazon Bedrock), and marked as image-capable or text-only by LLM_PRIMARY_VISION (default text-only).
- **Fallback_Model**: The partner model the LLM_Router tries after a Primary_Model failure, named by LLM_FALLBACK_MODEL (default Anthropic Claude Sonnet 4.5 on Amazon Bedrock), and marked as image-capable or text-only by LLM_FALLBACK_VISION (default image-capable).
- **Sanitizer**: The API_Service component that cleans untrusted input, including OCR-extracted text, before it enters an LLM prompt.
- **Anomaly**: A detected data defect, such as an orphan foreign key, negative stock or ledger balance, truncated field, byte-offset overflow, duplicate ledger entry, or statistical outlier.
- **Severity**: The Anomaly classification: low, medium, or critical.
- **Confidence_Score**: A decimal in the range 0.0 to 1.0 expressing certainty of an inference, detection or OCR reading.
- **Bounding_Box**: A rectangle given as integer pixel values x, y, width and height, with the origin at the top-left corner of the original uploaded image, that encloses one extracted cell or one Vision_Defect, together with the cell text and its Confidence_Score.
- **Vision_Defect**: A defect detected by the vision_extractor in an image, of exactly one type from the set {smudged_digit, torn_total, misaligned_column}, with its Bounding_Box and Confidence_Score.
- **Outlier_Score**: The value that the scikit-learn IsolationForest `decision_function` returns for one row; lower values indicate more anomalous rows, and a value below -0.15 marks a statistical outlier.
- **Spatial_Coordinates**: The (x, y, z) triple that the ml_rot_scorer computes for one record by `PCA(n_components=3)` projection of the Record_Embeddings (or, in the numeric fallback, of the standardized numeric feature matrix), normalized to the range -1.0 to 1.0 on each axis, used to position records in the Autopsy_Table.
- **Vision_X_Ray**: The Web_App feature, implemented by the component `VisionXRayOverlay.tsx`, that overlays SVG Bounding_Boxes and confidence heatmaps on the uploaded image, switched on and off by a "Vision X-Ray" toggle.
- **Vector_Store**: The Supabase pgvector database holding Record_Embeddings for Semantic_Search. The Vector_Store is used only for indexing and search, never for computing Spatial_Coordinates.
- **Record_Embedding**: The fixed-dimension (384 floats) vector that the Embedding_Provider computes for one record from its entity name and field values. The ml_rot_scorer computes it once, uses it for the PCA, and the api_resurrector reuses the same vector for indexing in the Vector_Store.
- **Embedding_Provider**: The API_Service component that computes Record_Embeddings. The default local provider is a deterministic feature-hashed embedding of the record field values, with no model weights and no GPU. An optional API provider calls a configured embedding endpoint. Neither provider is an LLM_Router provider.
- **Semantic_Search**: The API_Service capability that answers natural-language queries using the Vector_Store.
- **Cache**: The Redis cache with time-to-live (TTL) entries.
- **MCP_Server**: The Model Context Protocol server in `packages/mcp-server`.
- **Preset**: A built-in sample in `sample-dumps/`: "1994 Mainframe Ledger Dump", "Corrupted F&B Warehouse POS Batch", or the image Preset "Faded Dot-Matrix Manifest" (`sample-dumps/faded_dotmatrix_manifest.png`).
- **Analysis_Session**: One end-to-end processing run of one upload (a text file or an image) or Preset, identified by a unique session ID.
- **SSE_Stream**: The Server-Sent Events channel carrying Forensic_Stitcher progress.
- **Mock_Data**: Typed fixture data that substitutes for API_Service responses during UI-first development.

## Requirements

### Requirement 1: Legacy Batch Ingestion

**User Story:** As a developer inheriting a legacy system, I want to drop a batch dump, a scan or a photo, or choose a sample, so that I can start an autopsy without preparing the data.

#### Acceptance Criteria

1. WHEN a user drops a file onto the Necro_Dropzone, THE Necro_Dropzone SHALL accept the file only if its extension, compared case-insensitively, is `.dat`, `.txt`, `.csv` or `.cpy` (text input), or `.png`, `.jpg` or `.jpeg` (image input).
2. IF a dropped file has an extension other than `.dat`, `.txt`, `.csv`, `.cpy`, `.png`, `.jpg` or `.jpeg`, THEN THE Necro_Dropzone SHALL reject the file and display an alert with `role="alert"` listing the seven accepted extensions.
3. THE Necro_Dropzone SHALL offer exactly three Presets, "1994 Mainframe Ledger Dump", "Corrupted F&B Warehouse POS Batch" and "Faded Dot-Matrix Manifest", as selectable options.
4. WHEN a user drops a file or selects a Preset, THE Web_App SHALL validate the file size and dispatch the upload request within 500 ms of the drop or selection event.
5. IF a text file exceeds 5 MB (5,242,880 bytes), THEN THE Necro_Dropzone SHALL reject the file without dispatching an upload request and display an alert with `role="alert"` stating the 5 MB size limit. A text file of exactly 5,242,880 bytes SHALL be accepted.
6. IF an image file exceeds 10 MB (10,485,760 bytes), THEN THE Necro_Dropzone SHALL reject the file without dispatching an upload request and display an alert with `role="alert"` stating the 10 MB image size limit. An image file of exactly 10,485,760 bytes SHALL be accepted.
7. IF a file begins with a binary executable header (ELF magic bytes `7F 45 4C 46`, Mach-O magic bytes, or PE/MZ magic bytes `4D 5A`), THEN THE API_Service SHALL reject the file, create no Analysis_Session, and return an error response that names the rejection reason as a binary executable file.
8. IF the first bytes of a file do not match its extension, that is, a `.png` file does not begin with the PNG magic bytes `89 50 4E 47 0D 0A 1A 0A`, a `.jpg` or `.jpeg` file does not begin with the JPEG magic bytes `FF D8 FF`, or a `.dat`, `.txt`, `.csv` or `.cpy` file begins with the PNG or JPEG magic bytes, THEN THE API_Service SHALL reject the file, create no Analysis_Session, and return an error response that names the rejection reason as a file signature that does not match the extension.
9. IF a file is rejected by the Necro_Dropzone or the API_Service, THEN THE Web_App SHALL keep the current Analysis_Session interactive, retain the previously loaded data, and enable a new file selection within 500 ms of the rejection.
10. WHILE the Necro_Dropzone has keyboard focus, THE Necro_Dropzone SHALL allow a user to open the file picker with the Enter or Space key and to move between Presets with the Tab and Arrow keys. The same user SHALL be able to select a Preset with the Enter or Space key, without using a pointing device.
11. THE API_Service SHALL reject any text upload larger than 5 MB (5,242,880 bytes) and any image upload larger than 10 MB (10,485,760 bytes) with an error response stating the applicable size limit, regardless of whether the Web_App performed its own size check.
12. WHEN the API_Service accepts a file, THE API_Service SHALL create one Analysis_Session and return its unique session ID within 2 seconds.
13. IF the API_Service is unreachable or does not respond within 10 seconds of an upload request, THEN THE Web_App SHALL display an alert with `role="alert"` indicating the upload failed, create no Analysis_Session, and allow the user to retry.

### Requirement 2: Deterministic Legacy Parsing

**User Story:** As a developer, I want the raw structure of the dump detected deterministically, so that downstream analysis starts from reliable facts.

#### Acceptance Criteria

1. WHEN an accepted text file is received, THE Legacy_Parser SHALL detect the line delimiter as exactly one of LF, CRLF, CR, or fixed-length records with no delimiter, and SHALL return the same result for identical input bytes on every run.
2. WHEN an accepted text file is received, THE Legacy_Parser SHALL detect the text encoding as exactly one of ASCII, UTF-8, or EBCDIC, and SHALL report a Confidence_Score between 0.0 and 1.0 inclusive for the detected encoding.
3. IF the detected encoding is EBCDIC, THEN THE Legacy_Parser SHALL decode the content to UTF-8 using code page 037, and SHALL map any byte with no code page 037 mapping to the Unicode replacement character U+FFFD.
4. IF no encoding can be detected with a Confidence_Score of at least 0.5, THEN THE Legacy_Parser SHALL decode the content as UTF-8, replace each invalid byte sequence with U+FFFD, and set the encoding-uncertain flag to true in the parse result.
5. WHEN a fixed-width file is received, THE Legacy_Parser SHALL return a list of candidate column boundaries as zero-based byte offsets in ascending order, with at most 100 boundaries.
6. WHEN a CSV file is received, THE Legacy_Parser SHALL detect the field delimiter as exactly one of comma, semicolon, tab, or pipe, and SHALL report whether a header row is present as true or false.
7. WHEN parsing completes, THE API_Service SHALL return a raw preview containing the first 50 records (or all records if fewer than 50 exist), the detected delimiter, the detected encoding and the candidate column boundaries.
8. WHEN a parsed record set is submitted for serialization, THE Pretty_Printer SHALL serialize it back into the detected fixed-width or CSV format, using the detected line delimiter, encoding, field delimiter and column boundaries.
9. FOR ALL valid parsed record sets, parsing, then printing, then parsing SHALL produce a record set with the same number of records, the same field count per record and identical field values (round-trip property).
10. IF a record cannot be parsed, THEN THE Legacy_Parser SHALL record the line number (starting at 1) and a reason indicating the failure cause in the parse result, exclude that record from the record set, and continue parsing the remaining records.

### Requirement 3: COBOL Copybook Parsing

**User Story:** As a developer, I want COBOL copybooks interpreted, so that field layouts are taken from the authoritative definition when one exists.

#### Acceptance Criteria

1. WHEN a `.cpy` file of 1 byte to 10 MB is received, THE Copybook_Parser SHALL parse level numbers (01 to 49, 66, 77 and 88), field names (1 to 30 characters), PIC clauses, USAGE clauses, OCCURS clauses and REDEFINES clauses into a structured layout.
2. WHEN a structured layout is produced, THE Copybook_Parser SHALL compute the zero-based byte offset and the byte length of every field in the layout, using the storage size defined by the field's PIC and USAGE clauses, and SHALL compute the total record length as the sum of the lengths of all non-redefining fields.
3. WHEN an OCCURS clause with a count from 1 to 9,999 is parsed, THE Copybook_Parser SHALL compute the byte length of the field as the element length multiplied by the count.
4. WHEN a copybook and a data file are both supplied in one Analysis_Session, THE schema_archaeologist SHALL use the copybook field offsets and lengths as the column boundaries for the data file.
5. WHEN a copybook layout is applied to a data file, THE rot_detector SHALL report each record whose byte length differs from the copybook record length as a byte-offset overflow Anomaly that includes the record number, the actual length in bytes and the expected length in bytes.
6. IF a copybook contains syntax that the Copybook_Parser cannot interpret, THEN THE Copybook_Parser SHALL return an error that includes the line number (starting at 1) and the text of the unsupported construct, SHALL return no partial layout, and SHALL leave the Analysis_Session data unchanged.
7. IF a `.cpy` file is empty or contains no field definitions, THEN THE Copybook_Parser SHALL return an error indicating that no layout was found.
8. WHEN a structured layout is supplied, THE Copybook_Pretty_Printer SHALL serialize it into copybook text.
9. FOR ALL valid structured layouts, printing, then parsing SHALL produce a layout equivalent to the original, with equal level numbers, field names, PIC clauses, USAGE clauses, OCCURS clauses, REDEFINES clauses, byte offsets and byte lengths (round-trip property).

### Requirement 4: Computer Vision Extraction

**User Story:** As a developer holding only a scan or a photo of a printed invoice, CRT screen or dot-matrix manifest, I want the table read from the image into structured rows, so that paper-era records can be autopsied like digital dumps.

#### Acceptance Criteria

1. WHEN the Analysis_Session input is a `.png`, `.jpg` or `.jpeg` image, THE Forensic_Stitcher SHALL execute the vision_extractor as the first node, before any other node begins execution.
2. WHEN the Analysis_Session input is a `.dat`, `.txt`, `.csv` or `.cpy` file or a text Preset, THE Forensic_Stitcher SHALL NOT execute the vision_extractor, and THE API_Service SHALL report the vision_extractor as skipped with the reason "text_input" through the SSE_Stream within 500 ms of the session start.
3. IF an image cannot be decoded, has a width or height below 200 pixels, or has more than 40,000,000 pixels (width multiplied by height), THEN THE Forensic_Stitcher SHALL mark the vision_extractor as failed with the error code "unreadable_image", report an error through the SSE_Stream that identifies the node and the reason, and keep the Analysis_Session available for inspection.
4. WHEN a decodable image is received, THE vision_extractor SHALL apply the following steps in this order: deskew (estimating the skew angle and rotating the image to correct skew angles from -45 to +45 degrees, recording the estimated angle in degrees to one decimal place), CLAHE contrast enhancement on the grayscale image with a clip limit of 2.0 and an 8 by 8 tile grid, adaptive thresholding to a binary image, and table-grid contour detection that yields the cell rectangles of the table.
5. WHEN table-grid contour detection yields at least 2 rows and at least 2 columns of cells, THE vision_extractor SHALL run OCR on each cell and SHALL output the structured rows, ordered top to bottom with row numbers starting at 1, and the cells of each row, ordered left to right.
6. THE vision_extractor SHALL select the OCR engine from the environment variable OCR_ENGINE, accepting the values "paddleocr" and "tesseract" with a default of "paddleocr". IF OCR_ENGINE is missing or has any other value, THEN THE vision_extractor SHALL use the default and log a warning identifying the invalid value.
7. IF the selected OCR engine is unavailable or raises an error, THEN THE vision_extractor SHALL run OCR with the other engine.
8. IF both OCR engines fail, the mean cell Confidence_Score over all cells is below 0.4, or table-grid contour detection yields fewer than 2 rows or fewer than 2 columns, THEN THE vision_extractor SHALL submit the image once to the LLM_Router as a vision-LLM request for table extraction, and SHALL accept the response only if it passes structured-output validation for rows of cells, each with text, a Bounding_Box and a Confidence_Score between 0.0 and 1.0.
9. THE LLM_Router SHALL send the vision-LLM request of criterion 8 under the rules of Requirement 8, including the image-capability rule of criterion 8.9.
10. WHEN the vision_extractor sends an image to the LLM_Router, THE vision_extractor SHALL remove all embedded image metadata (including EXIF data) from the image before sending, and THE Sanitizer SHALL sanitize all OCR text and all vision-LLM response text under Requirement 17 before that text is stored in a row or included in any prompt.
11. THE vision_extractor SHALL output, for each cell, a Bounding_Box, the cell text and a Confidence_Score between 0.0 and 1.0 inclusive with a precision of two decimal places. Each Bounding_Box SHALL have a width and a height of at least 1 pixel and SHALL lie entirely within the original uploaded image, with deskew rotation reversed so that coordinates refer to the original uploaded image.
12. WHEN a cell has a Confidence_Score below 0.6, THE vision_extractor SHALL flag that cell as smudged (low confidence). A cell with a Confidence_Score of exactly 0.6 SHALL NOT be flagged.
13. WHEN the vision_extractor detects a smudged digit (a flagged cell whose text contains at least one digit or an unreadable character), a torn total (a cell in a column headed "total" or in the last row, whose text is not a valid number or whose grid contour is open), or a misaligned column (a column in which the horizontal center of a cell differs from the median center of that column by more than 25% of the median cell width of that column), THE vision_extractor SHALL record one Vision_Defect of the matching type with its Bounding_Box and a Confidence_Score.
14. IF no table can be detected and the vision-LLM request of criterion 8 returns no rows or fails, THEN THE Forensic_Stitcher SHALL mark the vision_extractor as failed with the error code "no_table_detected", report an error through the SSE_Stream that identifies the node, start no later node, and keep the Analysis_Session available for inspection.
15. IF the table contains more than 10,000 cells, THEN THE Forensic_Stitcher SHALL mark the vision_extractor as failed with the error code "cell_limit_exceeded" and report an error through the SSE_Stream that identifies the node.
16. THE vision_extractor SHALL complete the local steps (decoding, deskew, CLAHE, adaptive thresholding, grid detection and OCR) within 45 seconds for an image of up to 10 MB and 40,000,000 pixels, and SHALL complete the whole node, including any vision-LLM fallback, within 120 seconds.
17. IF the local steps exceed 45 seconds, THEN THE vision_extractor SHALL abandon the local steps and proceed as in criterion 8 as if both OCR engines had failed. IF the whole node exceeds 120 seconds, THEN THE Forensic_Stitcher SHALL mark the vision_extractor as failed with the error code "vision_timeout".
18. WHEN the vision_extractor completes, THE API_Service SHALL include in the completion event the structured rows, the Bounding_Boxes with text and Confidence_Scores, the Vision_Defects, the estimated skew angle, and the name of the engine that produced the text (paddleocr, tesseract, or the LLM provider).
19. THE API_Service SHALL depend on `opencv-python-headless` only and SHALL NOT install or import the GUI package `opencv-python`.
20. THE API_Service SHALL NOT include PyTorch or CUDA packages or model weights in its dependencies.
21. THE API_Service Docker image built for Railway deployment SHALL have an uncompressed size below 1.2 GB (1,200,000,000 bytes).

### Requirement 5: Schema Archaeology

**User Story:** As a developer, I want the hidden schema inferred, so that I can understand tables, keys and relationships nobody documented.

#### Acceptance Criteria

1. WHEN the Forensic_Stitcher starts an Analysis_Session with text input, THE Forensic_Stitcher SHALL execute the schema_archaeologist as the first node to execute, with the vision_extractor reported as skipped, before any other node begins execution.
2. WHEN the vision_extractor completes successfully for an image input, THE Forensic_Stitcher SHALL start the schema_archaeologist as the second node, immediately after the vision_extractor and before any other node begins execution, and THE schema_archaeologist SHALL run on the rows extracted by the vision_extractor, using the grid column index (starting at 1) as the position of each field.
3. WHEN the schema_archaeologist runs on an entity, THE schema_archaeologist SHALL infer the field names, field types, column boundaries (start position and end position of each field), candidate primary key and implicit foreign keys for that entity.
4. THE schema_archaeologist SHALL attach a Confidence_Score between 0.0 and 1.0 inclusive, with a precision of at least two decimal places, to each inferred field type, primary key and foreign key.
5. IF a file contains no header and no copybook, THEN THE schema_archaeologist SHALL generate each field name in the form "<inferred_type>_<position>", where position is the 1-based field index in the record, and SHALL keep the generated names unique within the entity.
6. WHEN an inferred foreign key references a field in another entity, THE schema_archaeologist SHALL record the source field, the target entity and the target field.
7. IF the schema_archaeologist output fails Pydantic validation, THEN THE Forensic_Stitcher SHALL mark the node as failed, report an error through the SSE_Stream that identifies the failing node and each invalid field, discard the invalid output, and keep the Analysis_Session available for inspection.
8. IF the schema_archaeologist cannot infer a candidate primary key for an entity, THEN THE schema_archaeologist SHALL report that entity with no primary key and a Confidence_Score of 0.0, and SHALL complete the node without failing it.

### Requirement 6: ML Rot Scoring

**User Story:** As a developer, I want statistical outliers flagged by a machine-learning model before any LLM runs, so that the rot findings are reproducible, cheap and not dependent on a language model's judgment.

#### Acceptance Criteria

1. WHEN the schema_archaeologist completes successfully, THE Forensic_Stitcher SHALL start the ml_rot_scorer as the third node, after the schema_archaeologist and before the rot_detector.
2. WHEN the ml_rot_scorer runs on an entity, THE ml_rot_scorer SHALL build a numeric feature matrix (used for the IsolationForest scoring and for the numeric fallback of criterion 24) from the entity's numeric columns (fields with an inferred integer or decimal type, such as unit prices, stock quantities, stock deltas and ledger amounts) plus one byte-length variance feature per row, defined as the squared difference between the row's byte length (the UTF-8 byte length of the row text) and the mean row byte length of the entity.
3. WHEN a numeric field value cannot be parsed or is missing, THE ml_rot_scorer SHALL replace it with the median of that column, and SHALL exclude from the feature matrix any column whose values are all identical.
4. THE ml_rot_scorer SHALL score each entity with scikit-learn `IsolationForest(contamination="auto", random_state=42)` and SHALL use the `decision_function` value as the Outlier_Score of each row.
5. FOR ALL identical inputs, THE ml_rot_scorer SHALL produce identical Outlier_Scores, rounded to 6 decimal places, on every run (determinism property).
6. WHEN a row has an Outlier_Score below -0.15, THE ml_rot_scorer SHALL flag the row as a statistical outlier. A row with an Outlier_Score of exactly -0.15 SHALL NOT be flagged.
7. IF an entity has fewer than 20 rows, has no numeric column (the byte-length variance feature alone is not sufficient), or has a feature matrix in which every column is constant, THEN THE ml_rot_scorer SHALL skip that entity, record the reason as "insufficient_rows", "no_numeric_columns" or "constant_features", record no Outlier_Score and no Spatial_Coordinates for that entity, and continue with the remaining entities.
8. IF the ml_rot_scorer skips every entity, THEN THE Forensic_Stitcher SHALL report the ml_rot_scorer as skipped through the SSE_Stream with the skip reasons, and SHALL continue with the rot_detector without raising an error.
9. WHERE the Embedding_Provider is the local provider, THE ml_rot_scorer SHALL complete embedding, scoring and projection for up to 50,000 rows in total within 10 seconds.
10. IF scikit-learn raises an error, or the ml_rot_scorer does not complete within 30 seconds, THEN THE Forensic_Stitcher SHALL report the ml_rot_scorer as skipped with the reason "scoring_error" or "timeout" and an error indication, discard all partial ML results, and continue with the rot_detector.
11. WHEN at least one row of an entity is flagged, THE ml_rot_scorer SHALL record exactly one Anomaly named "statistical_outlier" for that entity, containing the entity, the numeric column whose mean absolute z-score across the flagged rows is highest (the field), the flagged row numbers, and the Outlier_Score of each flagged row.
12. FOR ALL Anomalies recorded by the ml_rot_scorer, THE ml_rot_scorer SHALL set the row numbers to a subset of the row numbers present in the input data of the entity (invariant property).
13. WHEN an entity is scored and its Record_Embeddings are available, THE ml_rot_scorer SHALL project the Record_Embeddings of all rows of the entity with scikit-learn `PCA(n_components=3, svd_solver="full", random_state=42)` to exactly one Spatial_Coordinates triple (x, y, z) per row, for flagged and unflagged rows alike, so that records with similar field content are placed close together and records with corrupted content are placed apart from healthy clusters.
14. THE ml_rot_scorer SHALL divide each axis of the Spatial_Coordinates of an entity by the maximum absolute value on that axis within the entity, so that every coordinate is a finite number in the range -1.0 to 1.0 inclusive. IF the maximum absolute value on an axis is 0, THEN THE ml_rot_scorer SHALL set that coordinate to 0.0 for every row.
15. FOR ALL identical inputs and the same Embedding_Provider configuration, THE ml_rot_scorer SHALL produce identical Spatial_Coordinates, rounded to 6 decimal places, on every run and in every process (determinism property).
16. IF the Record_Embeddings of an entity have fewer than 3 non-constant dimensions, THEN THE ml_rot_scorer SHALL project with as many components as there are non-constant dimensions and SHALL set the remaining coordinates to 0.0 for every row; IF the Record_Embeddings have no non-constant dimension, THEN THE ml_rot_scorer SHALL apply the numeric fallback of criterion 24 to that entity.
17. THE ml_rot_scorer SHALL complete before the rot_detector sends any request to the LLM_Router, THE ml_rot_scorer SHALL NOT send any request to the LLM_Router, and no Outlier_Score and no Spatial_Coordinates value SHALL be computed or altered by an LLM.
18. WHEN the ml_rot_scorer completes, THE API_Service SHALL include in the completion event the Anomalies of criterion 11, the list of skipped entities with reasons, and the Spatial_Coordinates of at most 5,000 rows, selecting all flagged rows first and then unflagged rows at a uniform stride in ascending row-number order, together with the coordinate source ("embedding" or "numeric") and, when the source is "numeric" because of a fallback, the fallback reason.
19. THE ml_rot_scorer SHALL use scikit-learn on the CPU only and SHALL NOT require PyTorch or CUDA.
20. WHEN the ml_rot_scorer runs, THE ml_rot_scorer SHALL compute through the Embedding_Provider, before the PCA of criterion 13, exactly one Record_Embedding of 384 dimensions for each record of every entity, including entities that criterion 7 skips for scoring, from the record text defined in Requirement 14 criterion 1.
21. THE local Embedding_Provider SHALL compute each Record_Embedding by feature hashing of the entity name and field values into 384 dimensions with a process-independent hash and L2 normalization, SHALL produce identical vectors for identical record text on every run, and SHALL use no model weights, no GPU, no PyTorch and no CUDA.
22. WHERE the API embedding provider is configured, THE Embedding_Provider SHALL obtain Record_Embeddings from the configured embedding endpoint within 20 seconds, SHALL accept a response only when every vector has 384 finite components, and SHALL NOT send any request to the LLM_Router.
23. THE ml_rot_scorer SHALL pass the Record_Embeddings it computed to the api_resurrector, and WHEN the api_resurrector runs its indexing stage, THE api_resurrector SHALL store those same vectors in the Vector_Store without a second embedding pass; IF the ml_rot_scorer supplied no Record_Embedding for a record, THEN THE api_resurrector SHALL compute that Record_Embedding once through the Embedding_Provider.
24. IF the Record_Embeddings are unavailable because the Embedding_Provider raises an error, exceeds its deadline, or returns an invalid vector, THEN THE ml_rot_scorer SHALL compute the Spatial_Coordinates by PCA over the standardized numeric feature matrix of criterion 2 with the same normalization as criterion 14, SHALL report the coordinate source "numeric" and the fallback reason in the completion event of criterion 18, and SHALL NOT skip the node or an entity because of the embedding failure.
25. THE ml_rot_scorer SHALL compute Record_Embeddings and Spatial_Coordinates without any request to the Vector_Store, so that an unreachable Vector_Store affects only indexing and Semantic_Search.
26. THE API_Service SHALL keep the shape of each Spatial_Coordinates entry (entity, row number, x, y, z, flagged, Outlier_Score) in the completion event unchanged, and the added completion fields coordinate source and fallback reason SHALL be optional, so that a Web_App that ignores them renders the same Autopsy_Table.
27. THE API_Service SHALL document the embedding settings (provider selection, API endpoint, key and model) in the environment variable table and SHALL never log a Record_Embedding source text or an embedding API credential.

### Requirement 7: Rot Detection

**User Story:** As a developer, I want silent corruption surfaced and ranked, so that I know what to fix before migrating.

#### Acceptance Criteria

1. WHEN the ml_rot_scorer completes successfully or is reported as skipped, THE rot_detector SHALL start as the fourth node in the pipeline, after the ml_rot_scorer and before the api_resurrector.
2. WHEN the rot_detector starts, THE rot_detector SHALL run deterministic Pydantic validation checks for each of the following: orphan foreign keys, negative stock quantities, negative ledger balances, truncated fields, byte-offset overflows and duplicate ledger entries. The deterministic checks SHALL run on the parsed records or, for image input, on the rows extracted by the vision_extractor, and SHALL run whether or not the ml_rot_scorer produced outliers.
3. WHEN the ml_rot_scorer has recorded statistical_outlier Anomalies, THE rot_detector SHALL include each of them in its Anomaly list, SHALL NOT change their row numbers or Outlier_Scores, and SHALL assign each of them a Severity under criterion 7.
4. WHILE the LLM_Router has at least one available provider, THE rot_detector SHALL run semantic checks that explain the 10 flagged rows with the lowest Outlier_Score across the session (ties broken by ascending entity name, then ascending row number) and up to 10 orphan foreign key Anomalies (referential breaks), and that look for silent corruption that the deterministic checks in criterion 2 do not cover, and SHALL complete them within 60 seconds.
5. THE rot_detector SHALL assign each Anomaly exactly one Severity from the set {low, medium, critical} and a Confidence_Score between 0.0 and 1.0 inclusive.
6. THE rot_detector SHALL record, for each Anomaly, the entity, the field, the affected row numbers, between 0 and 5 sample corrupted rows (never more than 5, and all drawn from the affected row numbers), and a non-empty root-cause explanation. For a statistical_outlier Anomaly whose rows were not explained by the LLM, the root-cause explanation SHALL be generated from a fixed template that names the field, the number of flagged rows and the lowest Outlier_Score.
7. WHEN the rot_detector classifies a statistical_outlier Anomaly, THE rot_detector SHALL assign the Severity low if the lowest Outlier_Score of the Anomaly is greater than or equal to -0.30, and medium if it is below -0.30, SHALL NOT assign critical on the basis of the Outlier_Score alone, and SHALL set the Confidence_Score to the lowest Outlier_Score negated, divided by 0.5 and capped at 1.0, rounded to two decimal places.
8. WHEN an orphan foreign key, byte-offset overflow, or negative inventory value (negative stock quantity or negative ledger balance) is detected, THE rot_detector SHALL classify the Anomaly as critical with no Severity downgrade by semantic checks.
9. IF no LLM provider is available, THEN THE rot_detector SHALL return the deterministic results and the statistical_outlier Anomalies, mark the semantic checks as skipped in its output, and finish without raising an error.
10. IF the LLM_Router fails or exceeds the 60-second limit during semantic checks, THEN THE rot_detector SHALL retain all deterministic results and all statistical_outlier Anomalies already produced, mark the semantic checks as skipped, and include an error indication stating the failure reason.
11. IF the input data contains zero rows, THEN THE rot_detector SHALL return an empty Anomaly list and SHALL NOT report an error.
12. FOR ALL Anomalies produced, THE rot_detector SHALL set the affected row numbers to a subset of the row numbers present in the input data (invariant property).

### Requirement 8: LLM Routing and Failover

**User Story:** As a developer, I want the LLM layer to survive provider failures, so that an autopsy does not stall on one vendor.

#### Acceptance Criteria

1. WHEN a calling node submits an LLM request that the Primary_Model can accept, THE LLM_Router SHALL send the request to the Primary_Model first, before any request is sent to the Fallback_Model.
2. IF the Primary_Model returns an error response, does not respond within 30 seconds, or returns output that fails structured-output validation, THEN THE LLM_Router SHALL send the same request to the Fallback_Model within 3 seconds of detecting the failure.
3. IF the Fallback_Model returns an error response, does not respond within 30 seconds, or returns output that fails structured-output validation, THEN THE LLM_Router SHALL make no further provider attempts for that request, SHALL return a provider-failure error to the calling node that identifies both failed providers and the failure reason for each, and SHALL leave previously stored Analysis_Session results unchanged.
4. WHEN a request falls back to the Fallback_Model after a Primary_Model failure, THE LLM_Router SHALL emit one fallback event through the SSE_Stream within 1 second of sending the request to the Fallback_Model, and the event SHALL name the failed provider (`primary`) and the failure reason (error, timeout, or validation failure).
5. IF the LLM_Transport configuration (AWS_REGION and resolvable AWS credentials for "bedrock"; LLM_BASE_URL and LLM_API_KEY for "openai_compatible") or a model identifier (LLM_PRIMARY_MODEL or LLM_FALLBACK_MODEL) is absent when the LLM_Router starts, THEN THE LLM_Router SHALL report a configuration error naming the missing variable, without including any credential value, and SHALL NOT send requests to the affected model.
6. THE LLM_Router SHALL read provider credentials from environment variables or the standard AWS credential chain (shared profile or attached IAM role) only, and SHALL NOT write credential values to the SSE_Stream, error messages, or the Analysis_Session results.
7. WHEN an LLM request completes successfully, THE LLM_Router SHALL record the router role that produced the result (`primary` or `fallback`) alongside that result in the Analysis_Session results.
8. WHEN a request carries an image, as for the vision-LLM fallback of the vision_extractor, THE LLM_Router SHALL apply criteria 1 to 7 to that request in the same way as to a text request.
9. IF a request carries an image and the Primary_Model is marked text-only, THEN THE LLM_Router SHALL NOT send the request to the Primary_Model, SHALL send it to the Fallback_Model without emitting a fallback event, and, IF the Fallback_Model is also marked text-only, SHALL return a provider-failure error listing both models with the reason `unsupported_input`.

### Requirement 9: API Resurrection

**User Story:** As a developer, I want a modern REST wrapper generated, so that I can start migrating off the legacy data format immediately.

#### Acceptance Criteria

1. WHEN the rot_detector completes successfully, THE Forensic_Stitcher SHALL start the api_resurrector as the fifth and final node in the pipeline, after the rot_detector.
2. WHEN the api_resurrector starts, THE api_resurrector SHALL first run the indexing stage defined in Requirement 14 criterion 1, and SHALL then continue with the generation of criteria 3 to 7 whether the indexing stage succeeded or failed.
3. WHEN the api_resurrector starts the generation stage, THE api_resurrector SHALL generate exactly one Pydantic v2 model for each inferred entity, named after that entity.
4. WHEN the api_resurrector starts the generation stage, THE api_resurrector SHALL generate exactly one FastAPI APIRouter for each inferred entity, containing exactly five endpoints: create, read (single record by identifier), list, update and delete.
5. WHEN the api_resurrector finishes generating source, THE api_resurrector SHALL run a Python syntax check on the generated source, and the source SHALL pass only if it compiles with zero syntax errors.
6. WHEN a field has an inferred type and an inferred length, THE api_resurrector SHALL emit a Pydantic type annotation matching the inferred type and a maximum-length constraint equal to the inferred length.
7. WHEN an Anomaly affects a field, THE api_resurrector SHALL include a code comment directly above that field in the generated model, stating the Anomaly name and its Severity. IF multiple Anomalies affect the same field, THEN THE api_resurrector SHALL include one comment per Anomaly.
8. IF the syntax check fails, THEN THE Forensic_Stitcher SHALL mark the api_resurrector node as failed, report an error through the SSE_Stream within 2 seconds of the syntax check failing, identifying the node and the syntax error location, and retain the generated source for display.
9. IF the rot_detector fails, THEN THE Forensic_Stitcher SHALL NOT start the api_resurrector and SHALL report the api_resurrector as skipped through the SSE_Stream.
10. WHEN the api_resurrector completes with a passing syntax check, THE Web_App SHALL display the generated source in a read-only view, and SHALL provide a download action that saves the complete generated source as a single Python file.

### Requirement 10: Progress Streaming

**User Story:** As a user, I want live progress, so that I can see the autopsy unfold instead of waiting on a spinner.

#### Acceptance Criteria

1. WHEN an Analysis_Session starts, THE API_Service SHALL open an SSE_Stream for that session within 1 second of the session start.
2. WHEN a Forensic_Stitcher node starts, completes, fails or is skipped, THE API_Service SHALL emit an event on the SSE_Stream within 500 milliseconds of the state change. The event SHALL contain the node name (one of vision_extractor, schema_archaeologist, ml_rot_scorer, rot_detector, api_resurrector), the node state (started, completed, failed, or skipped), and a unique event ID that increases monotonically within the session.
3. WHEN a Forensic_Stitcher node completes, THE API_Service SHALL include that node's partial results in the completion event.
4. WHEN a Forensic_Stitcher node is skipped, THE API_Service SHALL include the skip reason in the skipped event and SHALL NOT emit a started event for that node.
5. WHEN the Analysis_Session input is text, THE API_Service SHALL emit a skipped event for the vision_extractor with the reason "text_input" as the first event after the SSE_Stream opens.
6. WHEN the final Forensic_Stitcher node completes, THE API_Service SHALL emit a terminal event and close the SSE_Stream within 1 second of emitting the terminal event.
7. IF the SSE_Stream connection drops before the terminal event is received, THEN THE Web_App SHALL attempt to reconnect up to 5 times, with the delay between attempts increasing from 1 second to a maximum of 16 seconds, and SHALL resume from the last received event ID.
8. WHEN the API_Service receives a reconnection that includes a last received event ID, THE API_Service SHALL replay every event emitted after that ID, in original order and without duplicates, before sending new events.
9. IF all 5 reconnection attempts fail, THEN THE Web_App SHALL stop retrying, display an error message indicating the connection was lost, and retain the progress already displayed.
10. WHILE the Forensic_Stitcher is running, THE Web_App SHALL display the current node name in an `aria-live="polite"` region and SHALL update the region within 500 milliseconds of receiving each node-started event.
11. IF a Forensic_Stitcher node fails, THEN THE API_Service SHALL emit an error event containing the node name and an error message, close the SSE_Stream, stop the Analysis_Session, preserve the partial results of previously completed nodes, and continue running without terminating the API_Service process.

### Requirement 11: 3D Autopsy Table Visualization

**User Story:** As a user, I want the inferred schema rendered as a 3D anatomy, so that I can see where the rot sits at a glance.

#### Acceptance Criteria

1. WHEN analysis results are available, THE Autopsy_Table SHALL render each inferred entity as one 3D node in a constellation layout within 2 seconds of the results being received, for up to 50 entities.
2. WHEN analysis results are available, THE Autopsy_Table SHALL render each foreign key relationship as one edge connecting the source node and the target node.
3. WHILE an entity has no Anomaly, THE Autopsy_Table SHALL render the node with a steady pulse animation at a constant rate of 1 pulse cycle per 2 seconds.
4. WHILE an entity has at least one critical Anomaly, THE Autopsy_Table SHALL render the node in crimson and SHALL render an animated trace arc along each edge connected to that node that is affected by a critical Anomaly.
5. WHERE the ml_rot_scorer provided Spatial_Coordinates for an entity, THE Autopsy_Table SHALL render each provided record as a point at a position derived from its Spatial_Coordinates, namely the node position of the entity plus the Spatial_Coordinates multiplied by one constant scale factor for all records, so that the relative distances computed by the ml_rot_scorer are preserved.
6. WHEN the Autopsy_Table renders record points, THE Autopsy_Table SHALL render flagged statistical outlier records in crimson and unflagged records in a neutral color that differs from crimson, so that corrupted clusters are visibly separated from healthy ones.
7. IF the ml_rot_scorer provided no Spatial_Coordinates for an entity (the node was skipped, the entity was skipped, or the coordinates are absent), THEN THE Autopsy_Table SHALL position the node of that entity by the fallback constellation layout and SHALL render no record points for that entity.
8. WHEN a user clicks a node, THE Web_App SHALL open the Node_Inspector_Drawer for that entity within 300 milliseconds.
9. WHEN a user activates an entity in the Entity_List using Enter or Space, THE Web_App SHALL open the Node_Inspector_Drawer for that entity within 300 milliseconds.
10. WHILE the user's operating system reports a reduced-motion preference, THE Autopsy_Table SHALL replace pulse and trace arc animations with static visual indicators that remain distinguishable from each other and from nodes without Anomalies.
11. IF WebGL is unavailable on the device, THEN THE Web_App SHALL display the Entity_List and a message stating that 3D rendering is unavailable, and SHALL NOT display an empty or broken 3D canvas.
12. WHEN the Autopsy_Table renders a constellation of up to 50 nodes and up to 5,000 record points, THE Autopsy_Table SHALL maintain a frame rate of at least 30 frames per second, measured as the average over 10 seconds on a reference desktop browser.
13. WHILE the Web_App runs in UI-first development mode, THE Web_App SHALL render the Autopsy_Table from typed Mock_Data that conforms to the same TypeScript types as API_Service responses, including Spatial_Coordinates for at least one flagged and one unflagged cluster.
14. IF analysis results contain zero entities, THEN THE Autopsy_Table SHALL display an empty-state message indicating that no entities were inferred and SHALL render no nodes or edges.

### Requirement 12: Vision X-Ray Overlay

**User Story:** As a user who uploaded a scan or photo, I want to see on the image where digits are smudged, totals are torn or columns are misaligned, so that I can judge how far to trust the extracted rows.

#### Acceptance Criteria

1. WHERE the Analysis_Session input is an image, THE Web_App SHALL display the uploaded image together with a toggle labelled "Vision X-Ray", implemented by the component `VisionXRayOverlay.tsx`. WHERE the input is text, THE Web_App SHALL NOT display the toggle.
2. THE Vision_X_Ray toggle SHALL be off by default, SHALL expose its state through the `aria-pressed` attribute with the value "true" or "false", and SHALL be reachable with the Tab key and operable with the Enter or Space key.
3. WHEN the user turns the Vision_X_Ray toggle on, THE Web_App SHALL display within 300 milliseconds an SVG overlay containing one rectangle for each Bounding_Box returned by the vision_extractor. WHEN the user turns the toggle off, THE Web_App SHALL remove the overlay and keep the image displayed.
4. THE SVG overlay SHALL use a viewBox equal to the pixel width and height of the original image and SHALL be positioned over the displayed image at the same rendered size, so that each rectangle stays within 1 CSS pixel of its image region at every container width from 320 to 3,840 CSS pixels and at every browser zoom from 100% to 200%, and SHALL realign within 100 milliseconds of a resize.
5. THE Vision_X_Ray SHALL draw a green rectangle for each Bounding_Box with a Confidence_Score of at least 0.6 and no Vision_Defect, and a crimson rectangle for each Bounding_Box with a Confidence_Score below 0.6 or with at least one Vision_Defect.
6. THE Vision_X_Ray SHALL fill each rectangle with its stroke color at an opacity of 0.1 plus 0.5 multiplied by (1.0 minus the Confidence_Score), rounded to two decimal places, forming a confidence heatmap, and SHALL display a legend that maps the opacity scale to Confidence_Scores from 0.0 to 1.0.
7. WHEN a user hovers over or moves keyboard focus to a flagged region, THE Vision_X_Ray SHALL display the cell text, the Confidence_Score to two decimal places, and the Vision_Defect type, if any.
8. THE Vision_X_Ray SHALL provide a text alternative that lists each flagged region (each crimson rectangle) with its row number, column number, Vision_Defect type or "low confidence", and Confidence_Score to two decimal places, and SHALL expose the SVG overlay with `role="img"` and an accessible name that references that list.
9. IF the vision_extractor returned no flagged region, THEN THE Vision_X_Ray SHALL display a text message stating that no defects were detected, in place of the list.
10. WHILE the user's operating system reports a reduced-motion preference, THE Vision_X_Ray SHALL show and hide the overlay without animated motion, reaching its final state within 50 milliseconds.
11. IF the image fails to load or the vision_extractor returned no Bounding_Box, THEN THE Web_App SHALL disable the Vision_X_Ray toggle with `aria-disabled="true"` and SHALL display a message stating the reason.
12. WHILE the Web_App runs in UI-first development mode, THE Web_App SHALL render the Vision_X_Ray from typed Mock_Data that conforms to the same TypeScript types as API_Service responses and that includes at least one smudged_digit, one torn_total and one misaligned_column Vision_Defect.
13. WHEN the Vision_X_Ray renders up to 10,000 Bounding_Boxes, THE Web_App SHALL display the overlay within 1 second of the toggle being turned on.

### Requirement 13: Node Inspector Drawer

**User Story:** As a user, I want to inspect one entity in detail, so that I can read the evidence and the reasoning behind each finding.

#### Acceptance Criteria

1. WHEN the Node_Inspector_Drawer opens for an entity, THE Node_Inspector_Drawer SHALL display the entity name, the inferred fields of the entity, up to 5 sample corrupted rows, and, for each Anomaly of the entity, the root-cause explanation, the Severity and the Confidence_Score.
2. IF an entity has more than 5 corrupted rows, THEN THE Node_Inspector_Drawer SHALL display exactly 5 of them and an indication of the total number of corrupted rows.
3. WHEN the Node_Inspector_Drawer opens, THE Node_Inspector_Drawer SHALL move keyboard focus to an element inside the drawer within 100 ms and keep Tab and Shift+Tab navigation cycling among the focusable elements inside the drawer.
4. WHEN a user presses Escape while the Node_Inspector_Drawer is open, THE Node_Inspector_Drawer SHALL close and return keyboard focus to the element that opened the drawer.
5. THE Node_Inspector_Drawer SHALL expose `role="dialog"`, an accessible name that contains the entity name, and an accessible description that is programmatically associated with the drawer.
6. WHEN the Node_Inspector_Drawer opens or closes, THE Node_Inspector_Drawer SHALL animate the transition using Framer Motion with a duration of 150 to 400 ms.
7. WHILE the user's operating system reports a reduced-motion preference, THE Node_Inspector_Drawer SHALL open and close with no animated motion, and the drawer SHALL reach its final state within 50 ms.
8. WHERE an entity has no Anomaly, THE Node_Inspector_Drawer SHALL display a message stating that no anomalies were detected for that entity, in place of the Anomaly list.

### Requirement 14: Semantic Forensic Search

**User Story:** As an investigator, I want to ask questions in plain language, so that I can find affected records without writing queries.

#### Acceptance Criteria

1. WHEN the api_resurrector starts, THE API_Service SHALL, as the first stage of that node (the indexing stage), store in the Vector_Store the Record_Embedding of each parsed or extracted record, reusing the vectors from the ml_rot_scorer under Requirement 6 criterion 23, together with the session ID, entity name, row number and anomaly flags, completing the stage within 120 seconds for up to 50,000 records.
2. IF the Vector_Store is unreachable or the indexing stage exceeds 120 seconds, THEN THE API_Service SHALL mark the indexing stage as failed with an error indication stating the failure reason, SHALL include that indication in the api_resurrector completion event, and SHALL continue with the generation stage of the api_resurrector.
3. WHEN a user submits a natural-language query of 1 to 500 characters, THE Semantic_Search SHALL return up to 100 matching records ranked in descending order of vector similarity score.
4. WHEN a user submits a natural-language query against a session of up to 50,000 records, THE Semantic_Search SHALL return results within 2 seconds.
5. THE Semantic_Search SHALL include in each result the entity name, the row number, a similarity score between 0.0 and 1.0 inclusive, and the anomaly flags.
6. WHEN a user submits the query "Show all warehouse transfers with missing branch codes" against the Corrupted F&B Warehouse POS Batch Preset, THE Semantic_Search SHALL return records whose branch code field is empty, and no record with a non-empty branch code field SHALL appear in the results.
7. IF a query matches no records, THEN THE Semantic_Search SHALL return an empty result list and the Web_App SHALL display a message stating that no records matched the query.
8. THE Semantic_Search SHALL restrict results to records of the requesting Analysis_Session.
9. IF the Vector_Store is unreachable, THEN THE API_Service SHALL return a service-unavailable error to the search request within 5 seconds and keep all other API_Service endpoints operating.
10. WHEN the Web_App displays search results, THE Web_App SHALL highlight the corresponding nodes in the Autopsy_Table and announce the result count in an `aria-live="polite"` region.
11. IF a user submits an empty query, a whitespace-only query, or a query longer than 500 characters, THEN THE Semantic_Search SHALL reject the request with a validation error indicating the allowed length and SHALL NOT return any results.
12. IF a user submits a natural-language query before the indexing stage of the Analysis_Session has completed successfully, THEN THE Semantic_Search SHALL return an error indicating that the session is not yet indexed and SHALL NOT return any results.
13. WHEN the Semantic_Search embeds a query, THE Semantic_Search SHALL use the same Embedding_Provider and configuration that produced the Record_Embeddings of the requesting Analysis_Session.

### Requirement 15: Result Caching and Replay

**User Story:** As a user, I want repeat analyses to return instantly, so that I can revisit findings without re-running the pipeline.

#### Acceptance Criteria

1. WHEN an Analysis_Session completes successfully, THE API_Service SHALL store the results and the ordered list of SSE_Stream events recorded during that session in the Cache under a key derived from the SHA-256 hash of the uploaded content. For image input, the hash SHALL be computed over the uploaded image bytes before any decoding or preprocessing.
2. WHEN a request is received for content whose SHA-256 hash has a Cache entry that has not exceeded its TTL, THE API_Service SHALL return the cached results without running the Forensic_Stitcher.
3. WHEN a request is served from the Cache, THE API_Service SHALL return the first byte of the response within 300 ms, measured at the API_Service boundary, for cached payloads up to 10 MB.
4. THE API_Service SHALL set a TTL on every Cache entry, with a default of 86,400 seconds (24 hours), configurable through an environment variable accepting integer values from 60 to 604,800 seconds.
5. WHEN a request is served from the Cache, THE API_Service SHALL replay the recorded SSE_Stream events, including skipped events and the Bounding_Boxes and Spatial_Coordinates in the node completion events, in their original order with their original event types and payloads, and SHALL include an indicator in the response that the results were served from the Cache.
6. IF the Cache is unreachable or does not respond within 2 seconds, THEN THE API_Service SHALL run the Forensic_Stitcher as for an uncached request, log one warning that identifies the Cache failure, and return the results to the user without an error response.
7. FOR ALL cached results, reading a stored entry SHALL return a value equal to the value that was stored (round-trip property).
8. IF the environment variable for the TTL is missing, non-integer, or outside the range 60 to 604,800 seconds, THEN THE API_Service SHALL use the default TTL of 86,400 seconds and log a warning identifying the invalid value.
9. IF an Analysis_Session fails or is cancelled before completion, THEN THE API_Service SHALL NOT store any entry in the Cache for that session's content hash.

### Requirement 16: Kiro MCP Server

**User Story:** As a Kiro IDE user, I want to call the autopsy engine from my IDE, so that I can inspect legacy schemas without leaving my editor.

#### Acceptance Criteria

1. WHEN a client calls `inspect_legacy_schema` with a file path (a text file or a `.png`, `.jpg` or `.jpeg` image) or a Preset name (including "Faded Dot-Matrix Manifest"), THE MCP_Server SHALL return the inferred schema with a Confidence_Score between 0.0 and 1.0 for each inferred element.
2. WHEN a client calls `query_rot_anomalies` with a session ID, THE MCP_Server SHALL return only the Anomalies, including statistical_outlier Anomalies, that match every supplied optional Severity and entity filter, or all Anomalies of the session if no filter is supplied.
3. THE MCP_Server SHALL publish a JSON Schema input definition for each of the tools `inspect_legacy_schema` and `query_rot_anomalies`.
4. IF a tool call receives input that fails its JSON Schema, THEN THE MCP_Server SHALL return an error result that names each invalid parameter and SHALL NOT send any request to the API_Service.
5. IF a tool call references a text file larger than 5 MB (5,242,880 bytes), THEN THE MCP_Server SHALL return an error result stating the 5 MB size limit and SHALL NOT send the file to the API_Service.
6. IF a tool call references an image file larger than 10 MB (10,485,760 bytes), THEN THE MCP_Server SHALL return an error result stating the 10 MB image size limit and SHALL NOT send the file to the API_Service.
7. IF a tool call references an image file whose first bytes do not match its extension under Requirement 1 criterion 8, THEN THE MCP_Server SHALL return an error result stating that the file signature does not match the extension and SHALL NOT send the file to the API_Service.
8. IF the API_Service does not respond within 30 seconds or the connection to it fails, THEN THE MCP_Server SHALL return an error result stating that the API_Service is unavailable.
9. THE MCP_Server SHALL read the API_Service base URL and credentials from environment variables.
10. IF `query_rot_anomalies` receives a session ID that the API_Service does not recognize, THEN THE MCP_Server SHALL return an error result stating that the session was not found.
11. IF the API_Service base URL or credentials environment variable is missing or empty when a tool call is received, THEN THE MCP_Server SHALL return an error result naming the missing variable and SHALL NOT send any request to the API_Service.

### Requirement 17: Input Sanitization and Security

**User Story:** As a maintainer, I want untrusted legacy data and secrets handled safely, so that the engine cannot be hijacked or leak credentials.

#### Acceptance Criteria

1. WHEN file content, OCR-extracted text, vision-LLM response text or user query text is included in an LLM prompt, THE Sanitizer SHALL remove every control character (Unicode category Cc, except newline and tab), truncate each value to a configured maximum length (default 10,000 characters, configurable from 1 to 100,000), and wrap the value in delimiters that mark it as data.
2. IF file content, OCR-extracted text, vision-LLM response text or user query text contains text resembling instructions to the LLM, THEN THE Sanitizer SHALL pass the text to the prompt only inside the data delimiters, unmodified except for the control-character removal and truncation in criterion 1.
3. IF a value contains the data delimiter string, THEN THE Sanitizer SHALL neutralize the embedded delimiter so that the value cannot close the data block early.
4. WHEN the vision_extractor receives text from an OCR engine or from a vision-LLM response, THE Sanitizer SHALL remove control characters from each cell text and truncate each cell text to 1,000 characters before the text is stored in a row, regardless of whether the text is later included in a prompt.
5. WHEN the API_Service receives a request, THE API_Service SHALL validate every request body and parameter against a Pydantic model before processing.
6. IF request validation fails, THEN THE API_Service SHALL reject the request, indicate which fields failed, and perform no processing or state change.
7. THE NecroLegacy repository SHALL contain no API keys, tokens or passwords in source files.
8. THE API_Service, THE Web_App and THE MCP_Server SHALL read credentials from environment variables.
9. IF a required credential environment variable is missing at startup, THEN THE API_Service, THE Web_App or THE MCP_Server SHALL fail to start and report the name of the missing variable without printing any credential value.
10. THE NecroLegacy repository SHALL include a `.env.example` file listing each required variable name with an empty value.
11. THE API_Service SHALL exclude credentials, uploaded file content, uploaded image bytes and OCR-extracted text from log output at every log level.
12. THE API_Service SHALL accept cross-origin requests only from the configured Web_App origin and SHALL NOT return cross-origin permission headers for any other origin.
13. THE API_Service SHALL escape or parameterize all values used in Vector_Store queries.
14. IF an LLM response contains generated source code, THEN THE API_Service SHALL perform a syntax check on the code, report the result (pass or fail with the error location) to the caller, and SHALL NOT execute the code.

### Requirement 18: Accessibility

**User Story:** As a user who relies on a keyboard or screen reader, I want the full workbench to be usable, so that the 3D visualization and the image overlay do not exclude me.

#### Acceptance Criteria

1. THE Web_App SHALL make every interactive control, including the Vision_X_Ray toggle, reachable with the Tab and Shift+Tab keys and operable with the Enter or Space key, without requiring a pointing device.
2. WHILE an interactive control has keyboard focus, THE Web_App SHALL display a focus indicator with a contrast ratio of at least 3:1 against adjacent colors and a thickness of at least 2 CSS pixels.
3. THE Web_App SHALL provide a text summary of the Autopsy_Table state that lists, for each entity, its name, its count of Anomalies at each Severity level (zero counts included), and the names of the entities it has relationships with.
4. WHEN analysis results change, THE Web_App SHALL update the text summary and, within 1 second, announce the change in an `aria-live="polite"` region with a message of at most 250 characters that states the number of entities and the number of Anomalies.
5. THE Entity_List SHALL expose each entity with an accessible name in the form of the entity name followed by its highest Severity, or by the text "no anomalies" if the entity has none.
6. THE Web_App SHALL convey Anomaly state using a text label and an icon in addition to color, so that each Severity level can be identified with color removed.
7. THE Web_App SHALL render all text with a contrast ratio of at least 4.5:1 against its background, or at least 3:1 for text of 24 CSS pixels or larger, or 18.66 CSS pixels or larger if bold.
8. THE Web_App SHALL render the Autopsy_Table canvas with `role="img"` and an `aria-describedby` or `aria-label` value that references the text summary.
9. WHILE the browser zoom is set to any value from 100% to 200% on a viewport 1280 CSS pixels wide, THE Web_App SHALL display all content and keep all functionality available, with no horizontal scrolling of the page and no clipped or overlapping controls, including the uploaded image and the Vision_X_Ray overlay.
10. WHEN the user turns the Vision_X_Ray toggle on or off, THE Web_App SHALL announce the new state and the number of flagged regions in an `aria-live="polite"` region within 1 second.
11. THE Vision_X_Ray SHALL distinguish flagged rectangles from confident rectangles by a dashed stroke and a text label in addition to color, and SHALL draw each rectangle with a stroke of at least 2 CSS pixels and a 1 CSS pixel contrasting outer halo, so that each state can be identified with color removed.
12. THE Vision_X_Ray SHALL make each entry of its flagged-region list focusable with the Tab key, and WHEN a user activates an entry with the Enter or Space key, THE Vision_X_Ray SHALL highlight the matching rectangle on the image.
13. WHILE the user's operating system reports a reduced-motion preference, THE Vision_X_Ray SHALL display all overlay changes without animated motion.

### Requirement 19: Monorepo, Delivery and Repository Hygiene

**User Story:** As a maintainer and hackathon entrant, I want a clear repository structure and delivery path, so that the project can be built in the intended order and judged fairly.

#### Acceptance Criteria

1. THE NecroLegacy repository SHALL contain the directories `apps/web`, `apps/api`, `packages/mcp-server` and `sample-dumps` at the paths given, each containing at least one file tracked in Git.
2. THE `sample-dumps` directory SHALL contain exactly one file for each Preset, and each file name SHALL identify the Preset it belongs to. The file for the "Faded Dot-Matrix Manifest" Preset SHALL be `sample-dumps/faded_dotmatrix_manifest.png`.
3. THE file `sample-dumps/faded_dotmatrix_manifest.png` SHALL be a valid PNG image of at most 10 MB (10,485,760 bytes) and at least 1,000 pixels wide, SHALL contain a table with at least 5 rows and 3 columns, and SHALL contain at least one smudged digit, one torn total and one misaligned column.
4. THE `apps/web` directory SHALL contain the component file `VisionXRayOverlay.tsx`.
5. THE NecroLegacy repository SHALL track the `.kiro` directory in Git, and no pattern in any `.gitignore` file SHALL cause any file under `.kiro` to be ignored.
6. THE NecroLegacy repository SHALL include a file named `LICENSE` at the repository root whose text is the MIT license and names a copyright holder and year.
7. THE NecroLegacy repository SHALL document, in a README file at the repository root, the name, purpose and required or optional status of every environment variable used by the Web_App for Render deployment and by the API_Service for Railway deployment (including OCR_ENGINE), without including any secret values.
8. THE NecroLegacy implementation plan SHALL order delivery as Web_App with Mock_Data first (including the Vision_X_Ray and Spatial_Coordinates rendering), then API_Service with SSE_Stream, then MCP_Server, and no task for a later item SHALL precede the tasks of an earlier item.
9. WHEN the API_Service becomes available, THE Web_App SHALL replace Mock_Data with API_Service responses, and the TypeScript response type definitions SHALL be identical before and after the replacement, with the Web_App passing type checking with zero errors.
10. THE Presets SHALL be synthetic data containing no real personal or financial information, including no real names, email addresses, phone numbers, government identifiers, account numbers or payment card numbers, and the image Preset SHALL contain no embedded metadata (EXIF or PNG text chunks) other than image dimensions and color information.
11. IF a Preset file in `sample-dumps` contains a value matching a real-person identifier or a valid payment card number, THEN THE NecroLegacy repository checks SHALL fail and SHALL report the file name containing the value. For the image Preset, the checks SHALL apply to the text extracted from the image by the vision_extractor.
12. THE API_Service Docker image built for Railway deployment SHALL have an uncompressed size below 1.2 GB (1,200,000,000 bytes), and IF the built image reaches or exceeds that size, THEN THE NecroLegacy repository build checks SHALL fail and report the measured size.
13. IF any dependency manifest of the API_Service lists `opencv-python`, `torch`, or any package whose name begins with `nvidia-` or `cuda`, THEN THE NecroLegacy repository checks SHALL fail and SHALL report the manifest and the package name. The manifest SHALL list `opencv-python-headless` for OpenCV functionality.
