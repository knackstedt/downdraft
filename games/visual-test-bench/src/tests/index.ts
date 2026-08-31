// ============================================================================
// Test auto-discovery — Vite glob import
//
// Every `*.test.ts` file in this directory (or subdirectories) is imported
// eagerly at module load time. Each test module calls `registerTest()` at
// the top level to register itself.
//
// Game authors add a new test by creating a `*.test.ts` file here — no
// manual import list to maintain. Vite resolves the glob at build time,
// so new tests get hot-reload automatically.
// ============================================================================

const modules = import.meta.glob("./**/*.test.ts", { eager: true });

// Log discovered test modules for debugging.
const count = Object.keys(modules).length;
console.log(`[test-bench] discovered ${count} test module(s)`);
