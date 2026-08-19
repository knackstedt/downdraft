// Type declaration for xxh3-ts.
//
// The package ships .ts source files alongside .js and .d.ts. With
// moduleResolution "bundler", TypeScript resolves `export * from "./xxh3"` in
// index.d.ts to xxh3.ts (preferring .ts over .d.ts), which triggers a
// BigUint64Array<ArrayBufferLike> vs BigUint64Array<ArrayBuffer> error on
// TS 5.9+. This file is mapped via tsconfig `paths` so TypeScript uses these
// types instead of following into the package's .ts source. The runtime .js
// export is correct and Vite resolves the real module through node_modules.
export declare function XXH3_128(data: Uint8Array, seed?: bigint): bigint;
