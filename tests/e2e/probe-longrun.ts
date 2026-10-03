import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const pid = (g as any).process?.pid ?? (g as any).proc?.pid;
console.log("pid:", pid);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rss = async () => {
  try {
    const s = await Bun.file(`/proc/${pid}/status`).text();
    return Number(s.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024;
  } catch { return -1; }
};
const procs = async () => {
  try {
    const out = await Bun.$`ps --ppid ${pid} -o comm= 2>/dev/null`.text();
    return out.trim().split("\n").filter(Boolean).length;
  } catch { return -1; }
};
for (let i = 0; i < 15; i++) {
  await sleep(6000);
  console.log(`t=${(i + 1) * 6}s rss=${(await rss()).toFixed(0)}MB children=${await procs()}`);
}
await g.kill();
