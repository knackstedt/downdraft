import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "overburden", gpu: "swiftshader", mirrorOutput: false });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);
await g.client.screenshot("/var/tmp/ob-after-loading.png");
await sleep(900);
await g.client.screenshot("/var/tmp/ob-after-loading2.png");
await g.kill();
console.log("done");
