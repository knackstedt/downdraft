export interface ResourceToken<T> {
  readonly __resourceBrand: T;
  readonly key: string;
}

export function resourceToken<T>(key: string): ResourceToken<T> {
  return { __resourceBrand: undefined as unknown as T, key };
}
