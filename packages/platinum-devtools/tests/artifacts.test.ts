import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectArtifact, importArtifact } from "../src/targets/artifacts";

const dir = mkdtempSync(join(tmpdir(), "platinum-art-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function put(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("detectArtifact", () => {
  test("extension-based kinds", () => {
    expect(detectArtifact("/x/a.cpuprofile")).toBe("cpuprofile");
    expect(detectArtifact("/x/b.heapsnapshot")).toBe("heapsnapshot");
    expect(detectArtifact("/x/c.folded")).toBe("folded");
  });

  test("content-based kinds", () => {
    const cpu = put("p.json", JSON.stringify({ nodes: [], samples: [1, 2] }));
    expect(detectArtifact(cpu)).toBe("cpuprofile");
    const tr = put("t.json", JSON.stringify({ traceEvents: [] }));
    expect(detectArtifact(tr)).toBe("trace");
    const jsc = put("j.json", JSON.stringify({ version: 1, nodes: [], nodeConnections: [] }));
    expect(detectArtifact(jsc)).toBe("jsc-heap");
    const unknown = put("u.json", JSON.stringify({ hello: 1 }));
    expect(detectArtifact(unknown)).toBe("unknown");
  });
});

describe("importArtifact", () => {
  test("cpuprofile → CpuProfile", () => {
    const p = put("app.cpuprofile", JSON.stringify({
      nodes: [
        { id: 1, callFrame: { functionName: "root", url: "a.ts", lineNumber: 1 }, hitCount: 3, children: [2] },
        { id: 2, callFrame: { functionName: "leaf", url: "b.ts", lineNumber: 9 }, hitCount: 1, children: [] },
      ],
      startTime: 100, endTime: 500, samples: [1, 2], timeDeltas: [200, 200],
    }));
    const a = importArtifact(p);
    expect(a.kind).toBe("cpuprofile");
    expect(a.profile?.nodes).toHaveLength(2);
    expect(a.profile?.nodes[1]?.functionName).toBe("leaf");
    expect(a.profile?.nodes[1]?.line).toBe(9);
    expect(a.profile?.source).toBe("artifact");
  });

  test("v8 heapsnapshot → class summary", () => {
    const p = put("h.heapsnapshot", JSON.stringify({
      snapshot: { meta: { node_fields: ["type", "name", "id", "self_size"] } },
      nodes: [0, 1, 10, 64, 0, 1, 11, 32, 0, 2, 12, 8],
      strings: ["type", "ObjA", "ObjB"],
    }));
    const a = importArtifact(p);
    expect(a.kind).toBe("heapsnapshot");
    expect(a.heap?.totalBytes).toBe(104);
    expect(a.heap?.objectCount).toBe(3);
    expect(a.heap?.classes[0]?.name).toBe("ObjA");
    expect(a.heap?.classes[0]?.shallow).toBe(96);
  });

  test("jsc heap → class summary", () => {
    const p = put("j.json", JSON.stringify({
      version: 1,
      nodes: [0, 100, 0, 0, 0, 1, 50, 1, 0, 0],
      nodeClassNames: ["Obj", "Arr"],
      nodeConnections: [],
    }));
    const a = importArtifact(p);
    expect(a.kind).toBe("jsc-heap");
    expect(a.heap?.format).toBe("jsc");
    expect(a.heap?.classes.find((c) => c.name === "Obj")?.shallow).toBe(100);
    expect(a.heap?.classes.find((c) => c.name === "Arr")?.shallow).toBe(50);
  });

  test("trace events → network rows", () => {
    const p = put("trace.json", JSON.stringify({
      traceEvents: [
        { ph: "X", cat: "net", name: "req", ts: 2_000_000, dur: 500_000, args: { url: "http://a/b" } },
        { ph: "X", cat: "other", name: "unrelated", ts: 0, dur: 1 },
      ],
    }));
    const a = importArtifact(p);
    expect(a.kind).toBe("trace");
    expect(a.network).toHaveLength(1);
    expect(a.network?.[0]?.url).toBe("http://a/b");
    expect(a.network?.[0]?.durationMs).toBe(500);
  });

  test("folded stacks → profile tree", () => {
    const p = put("perf.folded", "main;foo (/src/a.ts:10) 5\nmain;bar 2\nother 1\n");
    const a = importArtifact(p);
    expect(a.kind).toBe("folded");
    const root = a.profile?.nodes[0];
    expect(root?.functionName).toBe("root");
    expect(root?.hitCount).toBe(8);
    const main = a.profile?.nodes.find((n) => n.functionName === "main");
    expect(main?.hitCount).toBe(7);
    const foo = a.profile?.nodes.find((n) => n.functionName === "foo");
    expect(foo?.url).toBe("/src/a.ts");
    expect(foo?.line).toBe(10);
  });
});
