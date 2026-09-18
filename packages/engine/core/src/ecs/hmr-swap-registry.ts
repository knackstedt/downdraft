import type { System } from "./system";

type SwapCallback = (newMod: Record<string, unknown>) => void;

const swapCallbacks = new Map<string, SwapCallback>();

export function registerHmrSwap(systemName: string, callback: SwapCallback): void {
  swapCallbacks.set(systemName, callback);
}

export function hmrSwap(systemName: string, newMod: Record<string, unknown>): void {
  const cb = swapCallbacks.get(systemName);
  if (cb) cb(newMod);
}

export function unregisterHmrSwap(systemName: string): void {
  swapCallbacks.delete(systemName);
}

export function clearHmrSwaps(): void {
  swapCallbacks.clear();
}
