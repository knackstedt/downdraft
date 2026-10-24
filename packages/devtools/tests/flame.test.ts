// flame.test.ts — regression coverage for `buildFlameSpans` (per-sample
// timeline reconstruction) and `flameFnColor` (stable per-function color).

import { test, expect, describe } from "bun:test";
import { buildFlameSpans, flameFnColor } from "../src/surfaces/flame";
import type { CpuProfile } from "../src/targets/model";

/** Minimal tree: root(0) → a(1) → b(2); root(0) → c(3). */
function prof(): CpuProfile {
  return {
    nodes: [
      { id: 0, functionName: "root", url: "", line: 0, hitCount: 0, children: [1, 3] },
      { id: 1, functionName: "a", url: "a.ts", line: 1, hitCount: 0, children: [2] },
      { id: 2, functionName: "b", url: "b.ts", line: 2, hitCount: 0, children: [] },
      { id: 3, functionName: "c", url: "c.ts", line: 3, hitCount: 0, children: [] },
    ],
    startUs: 1000,
    endUs: 0, // filled per-test
    samples: [],
    timeDeltasUs: [],
    source: "cdp",
  };
}

describe("buildFlameSpans", () => {
  test("children tile inside the parent window — disjoint calls produce separate spans", () => {
    const p = prof();
    // root→a→b for 3 samples, then root→c for 2, then root→a→b for 2.
    p.samples = [2, 2, 2, 3, 3, 2, 2];
    p.timeDeltasUs = [100, 100, 100, 100, 100, 100, 100];
    p.endUs = 1700;
    const spans = buildFlameSpans(p);
    const by = (id: number) => spans.filter((s) => s.nodeId === id);
    const b = by(2), c = by(3), a = by(1), root = by(0);
    // b appears in two disjoint windows → two spans, not one smeared bar.
    expect(b.length).toBe(2);
    expect(b[0]!.s).toBe(1000); expect(b[0]!.e).toBe(1300);
    expect(b[1]!.s).toBe(1500); expect(b[1]!.e).toBe(1700);
    // c fills exactly the gap between the two b windows.
    expect(c.length).toBe(1);
    expect(c[0]!.s).toBe(1300); expect(c[0]!.e).toBe(1500);
    // a tiles around c: two windows matching b's.
    expect(a.length).toBe(2);
    // root spans the whole capture, contiguous.
    expect(root.length).toBe(1);
    expect(root[0]!.s).toBe(1000); expect(root[0]!.e).toBe(1700);
  });

  test("same-depth spans never overlap", () => {
    const p = prof();
    p.samples = [2, 3, 2, 1, 3, 2, 3, 1, 2];
    p.timeDeltasUs = p.samples.map(() => 50);
    p.endUs = 1450;
    const spans = buildFlameSpans(p);
    const byDepth = new Map<number, { s: number; e: number }[]>();
    spans.forEach((s) => {
      const arr = byDepth.get(s.depth) ?? [];
      arr.push(s);
      byDepth.set(s.depth, arr);
    });
    byDepth.forEach((list, d) => {
      const sorted = [...list].sort((x, y) => x.s - y.s);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.s).toBeGreaterThanOrEqual(sorted[i - 1]!.e);
      }
      // depth row fully covers [startUs, endUs] (root's stack always has it).
      if (d === 0) {
        expect(sorted[0]!.s).toBe(1000);
        expect(sorted[sorted.length - 1]!.e).toBe(1450);
      }
    });
  });

  test("single uniform stack → one span per depth", () => {
    const p = prof();
    p.samples = [2, 2, 2, 2];
    p.timeDeltasUs = [10, 10, 10, 10];
    p.endUs = 1040;
    const spans = buildFlameSpans(p);
    expect(spans.length).toBe(3); // root, a, b
    spans.forEach((s) => { expect(s.s).toBe(1000); expect(s.e).toBe(1040); });
  });

  test("empty samples → no spans; missing parent guards against cycles", () => {
    const p = prof();
    expect(buildFlameSpans(p)).toEqual([]);
    // Cycle: node 1's parent is 2 (a→b→a) — must not hang.
    p.samples = [2];
    p.timeDeltasUs = [10];
    p.endUs = 1010;
    p.nodes[2]!.children = [1];
    const spans = buildFlameSpans(p);
    expect(spans.length).toBeGreaterThan(0);
  });
});

describe("flameFnColor", () => {
  test("same name → same color; different names map into the palette", () => {
    expect(flameFnColor("runLoop")).toBe(flameFnColor("runLoop"));
    expect(flameFnColor("")).toMatch(/^#[0-9a-f]{6}$/);
    const a = flameFnColor("alpha"), b = flameFnColor("beta");
    expect(a).toMatch(/^#[0-9a-f]{6}$/);
    expect(b).toMatch(/^#[0-9a-f]{6}$/);
  });
});
