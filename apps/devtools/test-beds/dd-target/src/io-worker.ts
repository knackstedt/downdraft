// io-worker — a second thread for per-thread REPL testing. Evaluates
// expressions posted as {id, expr} and replies {id, result|error}.

const g = globalThis as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };

g.onmessage = (e: MessageEvent) => {
  const { id, expr } = (e.data ?? {}) as { id?: number; expr?: string };
  if (id === undefined || typeof expr !== "string") return;
  try {
    // oxlint-disable-next-line no-eval -- REPL worker evaluates expressions by design
    g.postMessage({ id, result: { ok: true, value: String((0, eval)(expr)) } });
  } catch (err) {
    g.postMessage({ id, result: { ok: false, error: String(err) } });
  }
};
