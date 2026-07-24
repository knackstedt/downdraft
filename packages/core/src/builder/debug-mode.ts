import { Builder, getBuilderConfig } from "./builder.ts";
import type { BuilderConfig } from "./builder.ts";

export { Builder } from "./builder.ts";

export function createDebugBuilder(): Builder {
  return new Builder("debug");
}

export function getDebugConfig(): BuilderConfig {
  return getBuilderConfig("debug");
}
