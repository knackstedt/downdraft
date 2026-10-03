import { GameClient } from "@downdraft/engine/mcp/client";
const c = await GameClient.connect({ pid: 2371709 });
await c.screenshot("/var/tmp/fs-live.png");
console.log("shot");
process.exit(0);
