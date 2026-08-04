import { Builder, getBuilderConfig } from "./builder";
import type { BuilderConfig } from "./builder";

export { Builder } from "./builder";

export function createDebugBuilder(): Builder {
  return new Builder("debug");
}

export function getDebugConfig(): BuilderConfig {
  return getBuilderConfig("debug");
}
