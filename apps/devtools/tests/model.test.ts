import { describe, test, expect } from "bun:test";
import { pushPoint, type MetricSeries } from "../src/targets/model";

const mk = (cap = 4): MetricSeries => ({
  id: "s", label: "s", unit: "count", group: "g", t: [], v: [], cap,
  min: Infinity, max: -Infinity,
});

describe("pushPoint", () => {
  test("appends and tracks min/max", () => {
    const s = mk();
    pushPoint(s, 1, 5);
    pushPoint(s, 2, -3);
    pushPoint(s, 3, 9);
    expect(s.t).toEqual([1, 2, 3]);
    expect(s.v).toEqual([5, -3, 9]);
    expect(s.min).toBe(-3);
    expect(s.max).toBe(9);
  });

  test("ring buffer drops the oldest points past cap", () => {
    const s = mk(3);
    [1, 2, 3, 4, 5].forEach((i) => pushPoint(s, i, i * 10));
    expect(s.t).toEqual([3, 4, 5]);
    expect(s.v).toEqual([30, 40, 50]);
  });
});
