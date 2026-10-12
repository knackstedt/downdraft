// ============================================================================
// osr-interactions.spec.ts — pointer/click/focus reconciliation regressions
//
// Covers the OSR-layer click policy added for real-mouse flakiness:
//   - ≥2px jitter during a press still clicks (blitz drag-mode suppression
//     is salvaged when the release lands in the press subtree)
//   - cross-subtree releases emit no click and don't move focus
//   - stray releases (no outstanding press) emit no click/dblclick
//   - programmatic focus + focused-node removal emit blur/focus events
//   - a release outside the pressed control doesn't blur a focused input
//
// Requires the native-osr cdylib; skips when it hasn't been built.
// ============================================================================

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { OsrDoc } from "./native-osr-ffi";

const LIB = resolve(
  import.meta.dir,
  "../native-osr/target/release/libdowndraft_blitz_osr.so",
);
const haveLib = existsSync(LIB);

const HTML = `<html><body style="margin:0; user-select:none;">
  <div id="a" style="position:absolute;left:20px;top:20px;width:80px;height:30px;background:#0366d6">A</div>
  <div id="b" style="position:absolute;left:120px;top:20px;width:80px;height:30px;background:#333">B</div>
  <input id="field" style="position:absolute;left:20px;top:80px;width:200px;height:30px;user-select:auto">
</body></html>`;

const A = { x: 60, y: 35 };
const B = { x: 160, y: 35 };
const FIELD = { x: 120, y: 95 };
const BG = { x: 400, y: 200 };

// Nested control: a chip inside a row — exercises ancestor/descendant
// click-target reconciliation.
const NESTED_HTML = `<html><body style="margin:0; user-select:none;">
  <div id="row" style="position:absolute;left:20px;top:20px;width:300px;height:50px;background:#eee">
    <div id="chip" data-action="go" style="position:absolute;left:10px;top:10px;width:80px;height:30px;background:#0366d6">C</div>
  </div>
</body></html>`;
// chip rect: 30..110 x, 30..60 y
const CHIP = { x: 70, y: 45 };
const ROW_NEAR = { x: 70, y: 66 }; // 6px below the chip, on the row
const ROW_FAR = { x: 200, y: 45 }; // inside the row, clear of the chip

describe.skipIf(!haveLib)("osr click/focus reconciliation", () => {
  function open() {
    const doc = OsrDoc.create(640, 480, 1, HTML);
    if (!doc) throw new Error("doc create failed");
    doc.frame();
    return doc;
  }
  function evts(doc: OsrDoc) {
    return doc.pollEvents();
  }
  function types(doc: OsrDoc) {
    return evts(doc).map((e) => e.t);
  }
  function clickSeq(doc: OsrDoc, x: number, y: number, jx = 0, jy = 0) {
    doc.pointerDown(x, y, "left");
    if (jx || jy) doc.pointerMove(x + jx, y + jy);
    doc.pointerUp(x + jx, y + jy, "left");
  }

  it("clean click on a chip emits click", () => {
    const doc = open();
    clickSeq(doc, A.x, A.y);
    expect(types(doc)).toContain("click");
  });

  it("jittered press inside a chip still clicks it", () => {
    const doc = open();
    clickSeq(doc, A.x, A.y, 4, 2);
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "click")).toBe(true);
  });

  it("press A, release on B — no click", () => {
    const doc = open();
    doc.pointerDown(A.x, A.y, "left");
    doc.pointerMove(B.x, B.y);
    doc.pointerUp(B.x, B.y, "left");
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "click")).toBe(false);
    expect(ev.some((e) => e.t === "dblclick")).toBe(false);
  });

  it("stray release emits only mouseup", () => {
    const doc = open();
    doc.pointerUp(B.x, B.y, "left");
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "click")).toBe(false);
    expect(ev.some((e) => e.t === "dblclick")).toBe(false);
  });

  it("clicking a text input focuses it; background click blurs", () => {
    const doc = open();
    const field = doc.query("#field");
    clickSeq(doc, FIELD.x, FIELD.y);
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "focus" && e.n === field)).toBe(true);
    expect(doc.focusedNode()).toBe(field);

    clickSeq(doc, BG.x, BG.y);
    const ev2 = evts(doc);
    expect(ev2.some((e) => e.t === "blur" && e.n === field)).toBe(true);
    expect(doc.focusedNode()).not.toBe(field);
  });

  it("jittered background click still blurs the focused input", () => {
    const doc = open();
    const field = doc.query("#field");
    clickSeq(doc, FIELD.x, FIELD.y);
    evts(doc);
    clickSeq(doc, BG.x, BG.y, 5, 3);
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "blur" && e.n === field)).toBe(true);
    expect(doc.focusedNode()).not.toBe(field);
  });

  it("dragging out of a focused input keeps focus on release", () => {
    const doc = open();
    const field = doc.query("#field");
    clickSeq(doc, FIELD.x, FIELD.y);
    evts(doc);
    doc.pointerDown(FIELD.x, FIELD.y, "left");
    doc.pointerMove(BG.x, BG.y);
    doc.pointerUp(BG.x, BG.y, "left");
    evts(doc);
    expect(doc.focusedNode()).toBe(field);
  });

  it("release on an ancestor container doesn't steal focus", () => {
    const doc = open();
    const field = doc.query("#field");
    clickSeq(doc, FIELD.x, FIELD.y);
    evts(doc);
    // Press inside the input, release on <body> — an ancestor, so a click on
    // body is still emitted (nearest-common-ancestor semantics) but the
    // input must not lose focus.
    doc.pointerDown(FIELD.x, FIELD.y, "left");
    doc.pointerMove(300, 400);
    doc.pointerUp(300, 400, "left");
    evts(doc);
    expect(doc.focusedNode()).toBe(field);
  });

  it("press on background released over an input doesn't focus it", () => {
    const doc = open();
    doc.pointerDown(BG.x, BG.y, "left");
    doc.pointerMove(FIELD.x, FIELD.y);
    doc.pointerUp(FIELD.x, FIELD.y, "left");
    evts(doc);
    expect(doc.focusedNode()).not.toBe(doc.query("#field"));
  });

  it("double-click still synthesizes dblclick", () => {
    const doc = open();
    clickSeq(doc, A.x, A.y);
    evts(doc);
    clickSeq(doc, A.x, A.y);
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "click")).toBe(true);
    expect(ev.some((e) => e.t === "dblclick")).toBe(true);
  });

  it("right-click emits contextmenu, middle emits no click", () => {
    const doc = open();
    doc.pointerDown(A.x, A.y, "right");
    doc.pointerUp(A.x, A.y, "right");
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "contextmenu")).toBe(true);
    expect(ev.some((e) => e.t === "click")).toBe(false);

    doc.pointerDown(A.x, A.y, "middle");
    doc.pointerUp(A.x, A.y, "middle");
    const ev2 = evts(doc);
    expect(ev2.some((e) => e.t === "click")).toBe(false);
  });

  it("jittered release just off a chip onto its parent activates the chip", () => {
    const doc = OsrDoc.create(640, 480, 1, NESTED_HTML)!;
    doc.frame();
    const chip = doc.query("#chip");
    doc.pointerDown(CHIP.x, CHIP.y, "left");
    doc.pointerMove(ROW_NEAR.x, ROW_NEAR.y);
    doc.pointerUp(ROW_NEAR.x, ROW_NEAR.y, "left");
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "click" && e.n === chip)).toBe(true);
  });

  it("drag far off a chip onto its parent does not activate the chip", () => {
    const doc = OsrDoc.create(640, 480, 1, NESTED_HTML)!;
    doc.frame();
    const chip = doc.query("#chip");
    doc.pointerDown(CHIP.x, CHIP.y, "left");
    doc.pointerMove(ROW_FAR.x, ROW_FAR.y);
    doc.pointerUp(ROW_FAR.x, ROW_FAR.y, "left");
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "click" && e.n === chip)).toBe(false);
  });

  it("press on background released over a chip does not activate it", () => {
    const doc = OsrDoc.create(640, 480, 1, NESTED_HTML)!;
    doc.frame();
    const chip = doc.query("#chip");
    doc.pointerDown(BG.x, BG.y, "left");
    doc.pointerMove(CHIP.x, CHIP.y);
    doc.pointerUp(CHIP.x, CHIP.y, "left");
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "click" && e.n === chip)).toBe(false);
  });

  it("press on container padding released over a chip does not activate it", () => {
    const doc = OsrDoc.create(640, 480, 1, NESTED_HTML)!;
    doc.frame();
    const chip = doc.query("#chip");
    doc.pointerDown(ROW_FAR.x, ROW_FAR.y, "left");
    doc.pointerUp(CHIP.x, CHIP.y, "left");
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "click" && e.n === chip)).toBe(false);
  });

  it("focus changes alone flag the doc dirty for repaint", () => {
    // Pseudo-state flips (focus/active) mark ancestors' dirty_descendants —
    // restyle work — without producing layout damage. pending() must see it,
    // or the focus ring waits for the next event to wake the raster.
    const doc = open();
    doc.frame(); // settle initial render
    expect(doc.pending()).toBe(false);
    clickSeq(doc, FIELD.x, FIELD.y);
    expect(doc.pending()).toBe(true);
  });

  it("programmatic focus() emits focus/blur events", () => {
    const doc = open();
    const field = doc.query("#field");
    doc.focus(field);
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "focus" && e.n === field)).toBe(true);
    expect(doc.focusedNode()).toBe(field);

    doc.focus(0);
    const ev2 = evts(doc);
    expect(ev2.some((e) => e.t === "blur" && e.n === field)).toBe(true);
    expect(doc.focusedNode()).not.toBe(field);
  });

  it("removing the focused node via setInnerHtml emits blur", () => {
    const doc = open();
    const field = doc.query("#field");
    doc.focus(field);
    evts(doc);
    const body = doc.query("body");
    doc.setInnerHtml(body, `<div>gone</div>`);
    const ev = evts(doc);
    expect(ev.some((e) => e.t === "blur" && e.n === field)).toBe(true);
    expect(doc.focusedNode()).not.toBe(field);
  });
});
