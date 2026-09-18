import { profilingPreludePlugin } from "./profiling-prelude-plugin.ts";

describe("profilingPreludePlugin", () => {
  const plugin = profilingPreludePlugin();

  it("injects the prelude import into worker-entry files", () => {
    const code = "export function init() { return 42; }";
    const result = plugin.transform!(code, "/src/sim-worker.ts", {} as any) as any;
    expect(result).not.toBeNull();
    expect(result.code).toContain('import "@downdraft/engine/profiling/worker-prelude"');
    // Original code should still be present
    expect(result.code).toContain("export function init()");
  });

  it("skips non-worker files", () => {
    const code = "export const x = 1;";
    const result = plugin.transform!(code, "/src/utils.ts", {} as any) as any;
    expect(result).toBeNull();
  });

  it("skips spec files", () => {
    const code = "export const x = 1;";
    const result = plugin.transform!(code, "/src/sim-worker.spec.ts", {} as any) as any;
    expect(result).toBeNull();
  });

  it("skips .d.ts files", () => {
    const code = "export const x = 1;";
    const result = plugin.transform!(code, "/src/worker.d.ts", {} as any) as any;
    expect(result).toBeNull();
  });

  it("skips the pixi-ui worker", () => {
    const code = "export const x = 1;";
    const result = plugin.transform!(code, "/packages/engine/libraries/pixi-ui/src/pixi-ui-worker.ts", {} as any) as any;
    expect(result).toBeNull();
  });

  it("skips the profiler scene", () => {
    const code = "export const x = 1;";
    const result = plugin.transform!(code, "/packages/engine/libraries/profiler/src/profiler-scene.ts", {} as any) as any;
    expect(result).toBeNull();
  });

  it("is idempotent — skips files that already have the import", () => {
    const code = `import "@downdraft/engine/profiling/worker-prelude";\nexport const x = 1;`;
    const result = plugin.transform!(code, "/src/sim-worker.ts", {} as any) as any;
    expect(result).toBeNull();
  });

  it("handles .tsx worker files", () => {
    const code = "export function MyWorker() { return <div/>; }";
    const result = plugin.transform!(code, "/src/ui-worker.tsx", {} as any) as any;
    expect(result).not.toBeNull();
    expect(result.code).toContain('import "@downdraft/engine/profiling/worker-prelude"');
  });

  it("respects custom include/exclude patterns", () => {
    const customPlugin = profilingPreludePlugin({
      include: ["**/my-*.ts"],
      exclude: ["**/my-excluded-*.ts"],
    });
    // Matches include
    const r1 = customPlugin.transform!("x", "/src/my-foo.ts", {} as any) as any;
    expect(r1).not.toBeNull();
    // Matches include but also exclude
    const r2 = customPlugin.transform!("x", "/src/my-excluded-foo.ts", {} as any) as any;
    expect(r2).toBeNull();
    // Doesn't match include
    const r3 = customPlugin.transform!("x", "/src/foo.ts", {} as any) as any;
    expect(r3).toBeNull();
  });
});
