// ============================================================================
// xxh3.ts — typed seam over the `xxh3-ts` package
// ============================================================================
//
// xxh3-ts ships .ts sources alongside its .js/.d.ts: any specifier TypeScript
// can statically resolve (bare package, deep subpath, or a tsconfig `paths`
// alias — which tsx and Deno then also honor at runtime, resolving .d.ts to
// an empty module) ends up type-checking the package's own .ts source, which
// fails on TS 5.9+ (BigUint64Array<ArrayBufferLike> vs <ArrayBuffer>).
//
// Instead, the package is loaded through non-literal specifiers that keep it
// out of the type program entirely; the real CJS entry resolves normally at
// runtime under Vite's module runner, Bun, tsx, and Deno.

type Xxh3Fn = (data: Uint8Array, seed?: bigint) => bigint;

let impl: Xxh3Fn | undefined;

async function loadImpl(): Promise<Xxh3Fn> {
  if (impl) return impl;
  // Prefer the CJS entry through createRequire — available on Node, Bun,
  // tsx, and Deno (node_modules resolution).
  try {
    const nodeModule = (await import("node:" + "module")) as {
      createRequire: (base: string | URL) => (specifier: string) => { XXH3_128?: Xxh3Fn };
    };
    const f = nodeModule.createRequire(import.meta.url)("xxh3-ts/index.js").XXH3_128;
    if (f) return (impl = f);
  } catch {
    // createRequire unavailable or resolution failed — try a plain import.
  }
  const specifier = "xxh3-ts/index.js";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    XXH3_128?: Xxh3Fn;
    default?: { XXH3_128?: Xxh3Fn };
  };
  const f = mod.XXH3_128 ?? mod.default?.XXH3_128;
  if (!f) throw new Error("xxh3-ts: XXH3_128 export not found");
  return (impl = f);
}

/** XXH3-128 of `data`; resolves the CJS xxh3-ts implementation lazily. */
export async function XXH3_128(data: Uint8Array, seed?: bigint): Promise<bigint> {
  return (await loadImpl())(data, seed);
}
