// ============================================================================
// runtime-globals.d.ts — ambient declarations for runtime-specific globals
//
// platform-native runs under Bun, Node, and Deno. The Node/Deno typecheck has
// no access to Bun's builtin modules or Deno's namespace, so we declare the
// minimal surface we use here. These declarations are compile-time only —
// the runtime detection in ffi-adapter.ts decides which backend is live.
// ============================================================================

declare module "bun:ffi" {
  export interface CFunction {
    args?: string[];
    returns?: string;
  }
  export type ptr = number;
  export function dlopen(
    path: string,
    symbols: Record<string, CFunction>,
  ): { symbols: Record<string, (...args: unknown[]) => unknown>; close(): void };
  export function ptr(
    buffer: ArrayBufferView | ArrayBuffer,
    byteOffset?: number,
  ): number;
  export function toArrayBuffer(
    ptr: number,
    byteOffset?: number,
    byteLength?: number,
  ): ArrayBuffer;
  export function toBuffer(
    ptr: number,
    byteOffset?: number,
    byteLength?: number,
  ): Buffer;
  export class CString extends String {}
  export class JSCallback {}
  export enum FFIType {}
}

declare namespace Deno {
  class UnsafePointer {
    static create(value: bigint | number): UnsafePointer;
    static of(value: ArrayBufferView | ArrayBuffer): UnsafePointer | null;
    static equals(a: unknown, b: unknown): boolean;
    value: bigint;
  }
  class UnsafePointerView {
    constructor(pointer: UnsafePointer | bigint | number);
    getCString(): string;
    copyInto(destination: ArrayBufferView, offset?: number): void;
  }
  function dlopen(
    path: string,
    symbols: Record<
      string,
      {
        parameters: string[];
        result: string;
        callback?: boolean;
        nonblocking?: boolean;
      }
    >,
  ): { symbols: Record<string, (...args: unknown[]) => unknown>; close(): void };
}

// NOTE: no `declare const Deno`/`Bun` — a const cannot merge with a same-named
// namespace (duplicate identifier), and all runtime access goes through
// `(globalThis as any).Deno` / `.Bun` anyway. The Deno namespace above exists
// for type-space only. No `Bun` namespace is declared here: bun-types provides
// the real global, and a stub namespace would shadow it.
