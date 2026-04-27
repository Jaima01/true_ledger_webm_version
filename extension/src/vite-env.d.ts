/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the orchestrator service (e.g. http://localhost:8000). */
  readonly VITE_ORCHESTRATOR_BASE: string;
  /** Base URL of the raw backend service (e.g. http://localhost:8001). */
  readonly VITE_BACKEND_BASE: string;
  /** Route path for chunked WebM uploads (default: /api/analyze-chunk). */
  readonly VITE_CHUNK_ENDPOINT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}