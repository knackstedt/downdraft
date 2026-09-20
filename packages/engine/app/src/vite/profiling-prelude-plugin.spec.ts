import { profilingPreludePlugin } from "./profiling-prelude-plugin.ts";

// Vite's ObjectHook<transform> may be a bare fn or { handler } — call it uniformly.
const callTransform = (p: { transform?: unknown }, code: string, id: string): { code: string } | null =>
  (p.transform as unknown as (c: string, i: string, o?: unknown) => { code: string } | null)(code, id, {});

describe("profilingPreludePlugin", () => {
  const plugin = profilingPreludePlugin();

  it("injects the prelude import into worker-entry files", () => {
    const code = "export function init() { return 42; }";
    const result = callTransform(plugin, code, "/src/sim-worker.ts");
    expect(result).not.toBeNull();
    expect(result!.code).toContain('import "@downdraft/engine/profiling/worker-prelude"');
    // Original code should still be present
    expect(result!.code).toContain("export function init()");
  });

  it("skips non-worker files", () => {
    const code = "export const x = 1;";
    const result = callTransform(plugin, code, "/src/utils.ts");
    expect(result).toBeNull();
  });

  it("skips spec files", () => {
    const code = "export const x = 1;";
    const result = callTransform(plugin, code, "/src/sim-worker.spec.ts");
    expect(result).toBeNull();
  });

  it("skips .d.ts files", () => {
    const code = "export const x = 1;";
    const result = callTransform(plugin, code, "/src/worker.d.ts");
    expect(result).toBeNull();
  });

  it("skips the pixi-ui worker", () => {
    const code = "export const x = 1;";
    const result = callTransform(plugin, code, "/packages/engine/libraries/pixi-ui/src/pixi-ui-worker.ts");
    expect(result).toBeNull();
  });

  it("skips the profiler scene", () => {
    const code = "export const x = 1;";
    const result = callTransform(plugin, code, "/packages/engine/libraries/profiler/src/profiler-scene.ts");
    expect(result).toBeNull();
  });

  it("is idempotent — skips files that already have the import", () => {
    const code = `import "@downdraft/engine/profiling/worker-prelude";\nexport const x = 1;`;
    const result = callTransform(plugin, code, "/src/sim-worker.ts");
    expect(result).toBeNull();
  });

  it("handles .tsx worker files", () => {
    const code = "export function MyWorker() { return <div/>; }";
    const result = callTransform(plugin, code, "/src/ui-worker.tsx");
    expect(result).not.toBeNull();
    expect(result!.code).toContain('import "@downdraft/engine/profiling/worker-prelude"');
  });

  it("respects custom include/exclude patterns", () => {
    const customPlugin = profilingPreludePlugin({
      include: ["**/my-*.ts"],
      exclude: ["**/my-excluded-*.ts"],
    });
    // Matches include
    const r1 = callTransform(customPlugin, "x", "/src/my-foo.ts");
    expect(r1).not.toBeNull();
    // Matches include but also exclude
    const r2 = callTransform(customPlugin, "x", "/src/my-excluded-foo.ts");
    expect(r2).toBeNull();
    // Doesn't match include
    const r3 = callTransform(customPlugin, "x", "/src/foo.ts");
    expect(r3).toBeNull();
  });
});
