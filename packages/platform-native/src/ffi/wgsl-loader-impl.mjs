// Implementation for the wgsl loader (loaded via register() from wgsl-loader.mjs).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  const urlObj = new URL(url);
  const query = urlObj.searchParams;

  // .css — native has no stylesheet application; discard like the Bun
  // preload and package-native build do.
  if (urlObj.pathname.endsWith(".css")) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }

  // .wgsl?raw or bare .wgsl → return file contents as string
  if (urlObj.pathname.endsWith(".wgsl")) {
    const filePath = fileURLToPath(url);
    const source = readFileSync(filePath, "utf8");
    return {
      format: "module",
      source: `export default ${JSON.stringify(source)};`,
      shortCircuit: true,
    };
  }

  // ?url → return the file path as string
  if (query.has("url")) {
    const filePath = fileURLToPath(url);
    return {
      format: "module",
      source: `export default ${JSON.stringify(filePath)};`,
      shortCircuit: true,
    };
  }

  // ?worker → return the file path (for worker imports)
  if (query.has("worker")) {
    const filePath = fileURLToPath(url);
    return {
      format: "module",
      source: `export default ${JSON.stringify(filePath)};`,
      shortCircuit: true,
    };
  }

  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  // Strip ?raw, ?url, ?worker suffixes for resolution, then re-add
  const match = specifier.match(/^(.+?)(\?(raw|url|worker))$/);
  if (match) {
    const baseSpec = match[1];
    const query = match[2];
    try {
      const resolved = await nextResolve(baseSpec, context);
      resolved.url = resolved.url + query;
      return resolved;
    } catch {
      // Fall through to default
    }
  }
  return nextResolve(specifier, context);
}
