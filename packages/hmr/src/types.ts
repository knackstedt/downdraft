export interface ViteHotContext {
  accept(cb?: () => void): void;
  dispose(cb?: (data: unknown) => void): void;
  data: unknown;
}

export interface ComponentDefEntry {
  name: string;
  defaults: Record<string, unknown>;
  id: number;
}
