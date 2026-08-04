declare module "bun:ffi" {
  export type FFIType =
    | "void"
    | "i8"
    | "u8"
    | "i16"
    | "u16"
    | "i32"
    | "u32"
    | "i64"
    | "u64"
    | "f32"
    | "f64"
    | "ptr"
    | "bool";

  export const FFIType: {
    void: "void";
    i8: "i8";
    u8: "u8";
    i16: "i16";
    u16: "u16";
    i32: "i32";
    u32: "u32";
    i64: "i64";
    u64: "u64";
    f32: "f32";
    f64: "f64";
    ptr: "ptr";
    bool: "bool";
  };

  export type ForeignFunction = {
    args?: Array<FFIType>;
    returns?: FFIType;
    nonblocking?: boolean;
    abi?: "cdecl" | "stdcall" | "fastcall" | "thiscall" | "win64";
  };

  export type StaticFunctions = Record<string, ForeignFunction>;

  export function dlopen(filename: string, symbols: StaticFunctions): {
    close(): void;
    symbols: Record<string, (...args: unknown[]) => unknown>;
  };

  export function dlopenSymbols(filename: string, symbols: StaticFunctions): {
    close(): void;
    symbols: Record<string, (...args: unknown[]) => unknown>;
  };

  export type CFunction = {
    safe?: boolean;
    args?: Array<FFIType>;
    returns?: FFIType;
    ptr?: number;
    abi?: "cdecl" | "stdcall" | "fastcall" | "thiscall" | "win64";
  };

  export function CFunction(options: CFunction): (...args: unknown[]) => unknown;

  export type Ptr = number & { __ptrBrand: unique symbol };

  export function ptr(value: ArrayBuffer | number): Ptr;
  export function read(ptr: Ptr, offset?: number, size?: number): void;
  export function write(ptr: Ptr, value: unknown, offset?: number): void;

  export const suffix: string;
  export const prefix: string;
}
