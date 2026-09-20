// bun:test registers these as globals at runtime; spec files use them bare.
// Declared globally here so *.spec.ts typechecks without per-file imports.
import type * as BunTest from "bun:test";

declare global {
  const describe: typeof BunTest.describe;
  const it: typeof BunTest.it;
  const test: typeof BunTest.test;
  const expect: typeof BunTest.expect;
  const beforeAll: typeof BunTest.beforeAll;
  const afterAll: typeof BunTest.afterAll;
  const beforeEach: typeof BunTest.beforeEach;
  const afterEach: typeof BunTest.afterEach;
}
