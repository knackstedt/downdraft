// Shared test helpers — polling, sleeps, tmp homes.

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll a condition until true or timeout; resolves to the last result. */
export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000, step = 50): Promise<boolean> {
  const tries = Math.max(1, Math.ceil(ms / step));
  for (let i = 0; i < tries; i++) {
    if (await cond()) return true;
    await sleep(step);
  }
  return cond();
}
