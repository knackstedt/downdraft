// Minimal "bun:test" ambient declaration for the platform-native standalone
// typecheck (tsconfig.json here), which runs without bun-types. Kept out of
// src/ so it never enters the monorepo web/node programs, where it would
// shadow the real bun:test declarations.

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => unknown, timeout?: number): void;
  export function it(name: string, fn: () => unknown, timeout?: number): void;
  export function expect(actual: unknown): any;
  export function beforeAll(fn: () => unknown): void;
  export function afterAll(fn: () => unknown): void;
  export function beforeEach(fn: () => unknown): void;
  export function afterEach(fn: () => unknown): void;
}
