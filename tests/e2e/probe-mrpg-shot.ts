import { GameClient } from "@downdraft/engine/mcp/client";
const c = await GameClient.connect({ pid: 2367842 });
await c.screenshot("/var/tmp/mrpg-live.png");
console.log("shot");
process.exit(0);
