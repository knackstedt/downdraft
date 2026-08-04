import { Builder, getBuilderConfig } from "./builder";
import type { BuilderConfig } from "./builder";

export { Builder, getBuilderConfig } from "./builder";
export type { BuilderMode, BuilderConfig } from "./builder";

export function createDevBuilder(): Builder {
  return new Builder("dev");
}

export function getDevConfig(): BuilderConfig {
  return getBuilderConfig("dev");
}
