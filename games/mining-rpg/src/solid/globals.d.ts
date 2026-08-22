// Build-time global injected by the solidWorkerPlugin in electron.vite.config.ts.
// In production builds, this is replaced with the URL of the emitted worker chunk.
// In dev, this is undefined and the host falls back to the Vite dev server URL.
declare const __SOLID_WORKER_URL__: string | undefined;
