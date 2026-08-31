// ============================================================================
// Shared bench state types — used by main.tsx and app.tsx
// ============================================================================

import type { VisualTest } from "./test-registry";

export interface BenchState {
  tests: VisualTest[];
  activeTestId: string | null;
  fps: number;
  error: string | null;
  webgpuAvailable: boolean;
  rendererReady: boolean;
}
