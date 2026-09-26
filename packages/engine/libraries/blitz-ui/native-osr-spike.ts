/* oxlint-disable no-console -- manual harness/probe, prints directly */
// Spike: exercise the extended OSR FFI surface — events out, DOM mutations,
// dynamic fonts via ui://, dirty rects, and <input> editing round-trip.
// Run: bun packages/engine/libraries/blitz-ui/native-osr-spike.ts

import { readFileSync } from "node:fs";
import { OsrDoc, registerOsrResource } from "./src/native-osr-ffi";

const html = `<html><body style="margin:0;font-family:'UiTest',sans-serif;">
<button id="btn" data-ui data-action="fire" data-item="42"
  style="padding:10px;background:#333;color:#fff;">Fire</button>
<input id="inp" type="text" value="abc" style="position:absolute;top:60px;left:0;width:120px;" />
<div id="list" style="position:absolute;top:100px;"></div>
</body></html>`;

// 1. Dynamic font: register DejaVu under a custom family name via ui://
const fontBytes = new Uint8Array(readFileSync(
  new URL("./native/assets/DejaVuSans.woff2", import.meta.url).pathname));
console.log("register font:", registerOsrResource("ui://fonts/UiTest.woff2", fontBytes));

const doc = OsrDoc.create(400, 200, 1, `<html><head><style>
@font-face { font-family: 'UiTest'; src: url('ui://fonts/UiTest.woff2'); }
</style></head>${html.replace("<html>", "").replace("</html>", "")}</html>`);
if (!doc) { console.log("FAIL: doc null"); process.exit(1); }

// 2. First frame + dirty rect
const f0 = doc.frame();
console.log("frame0:", f0?.length, "rect:", doc.frameRect(), "pending:", doc.pending());

// 3. Click the button → event out
doc.pointerMove(20, 20); doc.pointerDown(20, 20); doc.pointerUp(20, 20);
let ev = doc.pollEvents();
console.log("click events:", ev);

// 4. Mutations: query + set_text + set_style + set_inner_html
const btn = doc.query("#btn");
console.log("query #btn →", btn);
console.log("setText:", doc.setText(btn, "Fired!"));
console.log("setStyle:", doc.setStyle(btn, "background", "#a00"));
const list = doc.query("#list");
console.log("setInnerHtml:", doc.setInnerHtml(list, "<li data-ui data-action='row' data-i='0'>row0</li><li>row1</li>"));

// 5. Frame again — expect non-null with a bounded rect
const f1 = doc.frame();
console.log("frame1:", !!f1, "rect:", doc.frameRect());

// 6. Third frame immediately — should be null (clean, identical)
const f2 = doc.frame();
console.log("frame2 (expect null-ish):", f2 === null ? "null" : f2.length, "pending:", doc.pending());

// 7. Text input: click the input (absolute at y=60), type a char, backspace
const inp = doc.query("#inp");
doc.pointerMove(10, 70); doc.pointerDown(10, 70); doc.pointerUp(10, 70);
let evs = doc.pollEvents();
console.log("focus click events:", evs.map(e => `${e.t}#${e.id ?? e.n}`));
doc.key(true, "x", "KeyX", "x"); doc.key(false, "x", "KeyX");
doc.key(true, "Backspace", "Backspace"); doc.key(false, "Backspace", "Backspace");
evs = doc.pollEvents();
console.log("input events:", evs);
console.log("input value now:", doc.getAttr(inp, "value"));

// 7b. Programmatic focus path: blur, re-focus via FFI, type again
doc.focus(0); doc.focus(inp);
doc.key(true, "z", "KeyZ", "z"); doc.key(false, "z", "KeyZ");
evs = doc.pollEvents();
console.log("post-focus input events:", evs.filter(e => e.t === "input" || e.t === "focus" || e.t === "blur"));
console.log("input value finally:", doc.getAttr(inp, "value"));

doc.destroy();
console.log("done");
