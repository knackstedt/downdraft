// Minimal ambient types for bun:test — the repo doesn't carry bun-types.
// Covers the surface our specs use; extend as needed.
declare module "bun:test" {
  export interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toBeLessThanOrEqual(n: number): void;
    toContain(item: unknown): void;
    toContainEqual(item: unknown): void;
    toHaveLength(n: number): void;
    toMatch(re: RegExp | string): void;
    toThrow(e?: unknown): void;
    not: Matchers;
    resolves: { [K in keyof Matchers]: (...a: unknown[]) => Promise<void> };
    rejects: { toThrow(e?: unknown): Promise<void> };
  }
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export const it: typeof test;
  export function expect(value: unknown): Matchers;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}
