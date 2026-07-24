import { Builder, getBuilderConfig } from "./builder.ts";
import type { BuilderConfig } from "./builder.ts";

export { Builder } from "./builder.ts";

export function createProdBuilder(): Builder {
  return new Builder("prod");
}

export function getProdConfig(): BuilderConfig {
  return getBuilderConfig("prod");
}
