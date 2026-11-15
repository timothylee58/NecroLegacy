# Technical Architecture & Stack Rules

## Core Stack
- **Frontend (`apps/web`):** Next.js 15 (App Router), React 19 (functional components only), TypeScript (strict mode), Tailwind CSS, shadcn/ui, Framer Motion (default for all UI transitions), and Three.js (`@react-three/fiber` or vanilla Three.js canvas wrapper with proper WebGL disposal).
- **Backend (`apps/api`):** Python 3.12+, FastAPI, Pydantic v2, LangGraph (`StateGraph`), Redis (TTL caching), and Supabase (`pgvector`).
- **LLM Routing:** Default to YTL AI Labs' **ILMU API** for primary inference; automatically fall back to **Anthropic Claude** if ILMU times out or fails structured JSON validation.

## Development Workflow Order
1. Build and verify responsive UI/UX components using typed mock data first (`apps/web/src/lib/mock-autopsy.ts`).
2. Integrate FastAPI REST and Server-Sent Events (SSE) endpoints second.
3. Connect the Kiro MCP server (`packages/mcp-server`) last.

## Computer Vision & ML Constraints
- **CV Pipeline (`vision_extractor.py`):** Use `opencv-python-headless` (never GUI `opencv-python` which breaks headless Linux Docker containers on Railway) for image deskewing, CLAHE contrast enhancement, and bounding-box extraction.
- **ML Pipeline (`ml_rot_scorer.py`):** Use `scikit-learn` `IsolationForest` (`contamination="auto"`, `random_state=42`) for deterministic tabular outlier scoring and `PCA(n_components=3)` to compute real 3D coordinates for the Three.js Autopsy Canvas.
- **Zero Heavy GPU Weights:** Keep the Railway Docker image under 1.2GB. Do not bundle multi-gigabyte PyTorch/CUDA weights; rely on OpenCV + scikit-learn + API-based Vision fallback.
