import { launchGame, parseJsonContent, sleep, type McpToolResult } from "./harness";

const game = await launchGame({
  game: "andrews-sandbox",
  gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
  deterministic: true,
  ignoreErrorPatterns: [/PIXI.*warning/i, /WebGL.*context.*lost/i, /perf.*extension/i, /dynamic import will not move/i],
});

try {
  const call = (name: string, args: Record<string, unknown>) =>
    game.mcpClient.callTool(name, args) as Promise<McpToolResult>;
  const uiState = async () => parseJsonContent(await call("get_ui_state", {})) as any;
  const key = async (k: string, code: string) => {
    await call("dispatch_key", { key: k, code, type: "keydown" });
    await call("dispatch_key", { key: k, code, type: "keyup" });
  };
  const click = async (x: number, y: number) => {
    for (let _i = 0, _it = ["mousedown", "mouseup", "click"], _n = _it.length; _i < _n; _i++) { const type = _it[_i];
      await call("dispatch_click", { x, y, type });
    }
  };

  await sleep(2000);

  await key("Escape", "Escape");
  await sleep(500);
  console.log("after ESC:", JSON.stringify(await uiState()));

  // Sidebar tab click ("Graphics" at index 1 → y = 92 + 43 + ~10)
  await click(40, 144);
  await sleep(500);
  const s1 = await uiState();
  console.log("after sidebar click:", JSON.stringify({ tab: s1.escMenuTab, showEscMenu: s1.showEscMenu }));

  // Back to main tab
  await click(40, 100);
  await sleep(500);
  console.log("back on main:", JSON.stringify({ tab: (await uiState()).escMenuTab }));

  // Click "Resume" row — content starts at x=244, first row label at y=70
  await click(300, 80);
  await sleep(500);
  const s2 = await uiState();
  console.log("after Resume click:", JSON.stringify({ showEscMenu: s2.showEscMenu, tab: s2.escMenuTab }));
  console.log(s2.showEscMenu === false ? "RESUME CLICK WORKED" : "BUG REPRODUCED: menu still open");
} finally {
  await game.kill();
}
