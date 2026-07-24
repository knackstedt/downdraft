import { Builder, getBuilderConfig } from "./builder.ts";
import type { BuilderConfig } from "./builder.ts";

export { Builder, getBuilderConfig } from "./builder.ts";
export type { BuilderMode, BuilderConfig } from "./builder.ts";

export function createDevBuilder(): Builder {
  return new Builder("dev");
}

export function getDevConfig(): BuilderConfig {
  return getBuilderConfig("dev");
}
