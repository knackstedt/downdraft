import { Builder, getBuilderConfig } from "./builder";
import type { BuilderConfig } from "./builder";

export { Builder } from "./builder";

export function createProdBuilder(): Builder {
  return new Builder("prod");
}

export function getProdConfig(): BuilderConfig {
  return getBuilderConfig("prod");
}
