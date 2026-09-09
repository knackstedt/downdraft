// Quick debug script: render the text scene in the browser and save the PNG.
import { join } from "node:path";
import { renderBrowser } from "./browser/render";

const out = join(import.meta.dir, "artifacts", "text-browser.png");
const res = await renderBrowser("text", out, console.log);
console.log("done:", res);
process.exit(0);
