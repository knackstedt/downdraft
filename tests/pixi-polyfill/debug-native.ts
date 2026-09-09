// Quick debug script: render the text scene natively and save the PNG.
import { join } from "node:path";
import { renderNative, disposeNativeHost } from "./native/render";

const out = join(import.meta.dir, "artifacts", "text-native.png");
const res = await renderNative("text", out, console.log);
console.log("done:", res);
await disposeNativeHost();
process.exit(0);
