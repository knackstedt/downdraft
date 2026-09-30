import { launchGame, parseJsonContent, sleep, type McpToolResult } from "./harness";
import { $ } from "bun";

const game = await launchGame({
  game: "andrews-sandbox",
  gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
  deterministic: true,
  ignoreErrorPatterns: [/PIXI.*warning/i, /WebGL.*context.*lost/i, /perf.*extension/i, /dynamic import will not move/i],
});

const call = (name: string, args: Record<string, unknown>) =>
  game.mcpClient.callTool(name, args) as Promise<McpToolResult>;
const uiState = async () => parseJsonContent(await call("get_ui_state", {})) as any;
const showEsc = async () => (await uiState()).showEscMenu;

let win = "";
const mv = (x: number, y: number) => $`xdotool mousemove --window ${win} ${x} ${y}`.quiet();
const clickAt = async (x: number, y: number) => { await mv(x, y); await sleep(120); await $`xdotool click --window ${win} 1`.quiet(); };
const key = (k: string) => $`xdotool key --window ${win} ${k}`.quiet();
const openMenu = async () => { await key("Escape"); await sleep(500); };

try {
  await sleep(2000);
  const out = await $`xdotool search --name "Sandbox"`.quiet();
  win = out.stdout.toString().trim().split("\n")[0];
  await $`xdotool windowactivate ${win}`.quiet().nothrow();
  await sleep(300);
  const geo = await $`xdotool getwindowgeometry --shell ${win}`.quiet();
  const w = Number(geo.stdout.toString().match(/WIDTH=(\d+)/)?.[1]);
  const h = Number(geo.stdout.toString().match(/HEIGHT=(\d+)/)?.[1]);

  // Engage pointer lock once.
  await clickAt(Math.floor(w / 2), Math.floor(h / 2));
  await sleep(500);

  // ── V1: open → click Resume (baseline) ──
  await openMenu();
  await clickAt(300, 80);
  await sleep(500);
  console.log("V1 basic:", (await showEsc()) === false ? "PASS" : "FAIL");

  // ── V2: open → keyboard-nav to content column → then click Resume ──
  await openMenu();
  await key("Right"); // sidebar → content column
  await key("Down");
  await sleep(300);
  await clickAt(300, 80);
  await sleep(500);
  console.log("V2 nav-then-click:", (await showEsc()) === false ? "PASS" : "FAIL");

  // ── V3: open → click sidebar tab (Graphics) → back to Menu → click Resume ──
  await openMenu();
  await clickAt(40, 135); // Graphics tab (92 + 43*1 = 135)
  await sleep(400);
  await clickAt(40, 92);  // Menu tab
  await sleep(400);
  await clickAt(300, 80);
  await sleep(500);
  console.log("V3 tab-then-resume:", (await showEsc()) === false ? "PASS" : "FAIL");

  // ── V4: open → click on the row DESC text ("Return to the game" ~y=89) ──
  await openMenu();
  await clickAt(300, 92);
  await sleep(500);
  console.log("V4 desc-area click:", (await showEsc()) === false ? "PASS" : "FAIL");

  // ── V5: open → slow real drag: press, move 2px, release on Resume ──
  await openMenu();
  await mv(295, 78);
  await $`xdotool mousedown --window ${win} 1`.quiet();
  await mv(300, 81);
  await sleep(80);
  await $`xdotool mouseup --window ${win} 1`.quiet();
  await sleep(500);
  console.log("V5 jitter click:", (await showEsc()) === false ? "PASS" : "FAIL");

  // ── V6: open → click empty area first, then Resume ──
  await openMenu();
  await clickAt(700, 400); // menu dim area — no element
  await sleep(300);
  console.log("  after empty click, menu:", await showEsc());
  await clickAt(300, 80);
  await sleep(500);
  console.log("V6 empty-then-resume:", (await showEsc()) === false ? "PASS" : "FAIL");

  // ── V7: open → ESC-close → reopen → click Resume ──
  await openMenu();
  await key("Escape"); // close
  await sleep(500);
  console.log("  after 2nd ESC, menu:", await showEsc());
  await key("Escape"); // reopen
  await sleep(500);
  await clickAt(300, 80);
  await sleep(500);
  console.log("V7 reopen-then-resume:", (await showEsc()) === false ? "PASS" : "FAIL");
} finally {
  await game.kill();
}
