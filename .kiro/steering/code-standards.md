# Code Quality, Accessibility & Documentation Standards

- **Comments Policy:** Keep comments minimal. Never narrate *what* obvious code does; only write comments explaining *why* a non-obvious architectural decision, byte-offset quirk, or workaround exists.
- **Accessibility (ARIA):** All interactive overlays, 3D node controls, and file uploaders must support keyboard navigation, `aria-label` attributes, and screen-reader summaries of 3D anomaly states.
- **Modularity:** Isolate LangGraph nodes into single-responsibility files under `apps/api/app/agents/nodes/`. Keep Three.js scene logic decoupled from React state management.
- **Safety & Hygiene:** Never hardcode API keys. Validate all uploads for size limits (5MB for text dumps, 10MB for images) and sanitize inputs, including OCR text, before LLM prompt injection.
