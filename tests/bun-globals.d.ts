// bun-types' index.d.ts does not reference bun.ns.d.ts, so the global `Bun`
// object is never installed. Install it here for the tests/ scripts, which
// run under `bun` and use Bun.spawn/Bun.serve/Bun.file/etc.
import * as BunModule from "bun";

declare global {
  export import Bun = BunModule;
}
