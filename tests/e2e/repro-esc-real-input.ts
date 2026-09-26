import { $ } from "bun";
import { launchGame, parseJsonContent, sleep, type McpToolResult } from "./harness";

const game = await launchGame({
  configPath: "games/andrews-sandbox/electron.vite.config.ts",
  gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
  deterministic: process.env.NO_DETERMINISTIC !== "1",
  ignoreErrorPatterns: [/PIXI.*warning/i, /WebGL.*context.*lost/i, /perf.*extension/i, /dynamic import will not move/i],
});

const call = (name: string, args: Record<string, unknown>) =>
  game.mcpClient.callTool(name, args) as Promise<McpToolResult>;
const uiState = async () => parseJsonContent(await call("get_ui_state", {})) as any;

let win = "";
let wx = 0, wy = 0, ww = 0, wh = 0;

// Real XTEST input — absolute screen coords, events go through the normal X
// input path like real user input.
const move = (x: number, y: number) => $`xdotool mousemove ${wx + x} ${wy + y}`.quiet();
const clickAt = async (x: number, y: number) => {
  await move(x, y);
  await sleep(120);
  await $`xdotool click 1`.quiet();
};
const realKey = (k: string) => $`xdotool key ${k}`.quiet();

try {
  await sleep(2500);
  const out = await $`xdotool search --name "Sandbox"`.quiet();
  win = out.stdout.toString().trim().split("\n")[0];
  console.log("window id:", win);
  await $`xdotool windowactivate ${win}`.quiet().nothrow();
  await sleep(400);
  const geo = await $`xdotool getwindowgeometry --shell ${win}`.quiet();
  const g = Object.fromEntries(geo.stdout.toString().trim().split("\n").map((l) => l.split("=")));
  wx = Number(g.X); wy = Number(g.Y); ww = Number(g.WIDTH); wh = Number(g.HEIGHT);
  console.log("geometry:", { wx, wy, ww, wh });

  // Verify mouse location tracks — move to center and check.
  await move(Math.floor(ww / 2), Math.floor(wh / 2));
  const loc = (await $`xdotool getmouselocation --shell`.quiet()).stdout.toString();
  console.log("cursor at:", loc.trim());

  // Click center → engage pointer lock.
  await clickAt(Math.floor(ww / 2), Math.floor(wh / 2));
  await sleep(800);
  console.log("after lock click:", JSON.stringify(await uiState()));

  // Real ESC → opens menu.
  await realKey("Escape");
  await sleep(800);
  const s0 = await uiState();
  console.log("after real ESC:", JSON.stringify({ showEscMenu: s0.showEscMenu, tab: s0.escMenuTab }));

  const shot = await call("capture_screenshot", { fullPage: false });
  const img = shot.content.find((c) => c.type === "image");
  if (img?.data) await Bun.write("/tmp/esc-menu.png", Buffer.from(img.data, "base64"));

  // Real click on "Resume" row (label at x≈244,y≈70; use 300,80).
  await clickAt(300, 80);
  await sleep(800);
  const s1 = await uiState();
  console.log("after real Resume click:", JSON.stringify({ showEscMenu: s1.showEscMenu, tab: s1.escMenuTab }));
  console.log(s1.showEscMenu === false ? "RESUME CLICK WORKED" : "BUG REPRODUCED: menu still open");
} finally {
  await game.kill();
}
