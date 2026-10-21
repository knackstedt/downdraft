// Bun host globals for the test-bed target (the engine's tri-runtime host
// doesn't type Bun; the target only runs under Bun for now).
declare const Bun: {
  serve(opts: { port?: number; fetch?: (req: Request) => Response | Promise<Response> }): { port: number; stop?: () => void };
  [k: string]: unknown;
};
