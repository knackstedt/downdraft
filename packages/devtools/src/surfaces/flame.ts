// ============================================================================
// flame.ts — flame-chart span reconstruction from CPU samples.
//
// `buildFlameSpans` turns the raw `samples[]` + `timeDeltasUs[]` timeline into
// contiguous per-depth spans — the real flame-chart primitive. Children always
// tile inside their parent's window, unlike approximations that draw every
// node at [first-seen, first-seen+total].
// ============================================================================

import type { CpuProfile } from "../targets/model";

/** One contiguous span where a node stayed on the sampled stack. */
export interface FlameSpan {
  nodeId: number;
  depth: number;
  s: number;
  e: number;
}

/** Reconstruct spans: for each sample the stack (root→leaf) is rebuilt via the
 *  parent map; a depth whose node changes or disappears closes the open span. */
export function buildFlameSpans(prof: CpuProfile): FlameSpan[] {
  const spans: FlameSpan[] = [];
  if (!prof.samples.length) return spans;
  const parent = new Map<number, number>();
  prof.nodes.forEach((n) => n.children.forEach((c) => parent.set(c, n.id)));
  // Per-depth index into `spans` of the currently open span.
  const open = new Map<number, number>();
  let t = prof.startUs;
  for (let i = 0; i < prof.samples.length; i++) {
    const stack: number[] = [];
    let cur: number | undefined = prof.samples[i];
    for (let guard = 0; cur !== undefined && guard < 300; guard++) {
      stack.push(cur);
      cur = parent.get(cur);
    }
    stack.reverse();
    // Close spans that disappeared or changed node at their depth.
    [...open.keys()].forEach((d) => {
      const oi = open.get(d)!;
      if (d >= stack.length || spans[oi]!.nodeId !== stack[d]) {
        spans[oi]!.e = t;
        open.delete(d);
      }
    });
    // Open spans for depths that newly have a node.
    for (let d = 0; d < stack.length; d++) {
      if (!open.has(d)) {
        open.set(d, spans.length);
        spans.push({ nodeId: stack[d]!, depth: d, s: t, e: t });
      }
    }
    t += prof.timeDeltasUs[i] ?? 0;
  }
  open.forEach((oi) => { spans[oi]!.e = t; });
  return spans;
}

/** Stable per-function color — hash of the name over a curated palette, so the
 *  same function keeps one color across pans, zooms, and captures. */
const FLAME_PALETTE = [
  "#e5a54b", "#d97d54", "#c96a6a", "#a76db5", "#6a8fc9", "#5fa8a0",
  "#6fab62", "#b5a04e", "#c97fa8", "#7a8cc4", "#63a3c9", "#9c8356",
];

export function flameFnColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff;
  return FLAME_PALETTE[h % FLAME_PALETTE.length]!;
}
