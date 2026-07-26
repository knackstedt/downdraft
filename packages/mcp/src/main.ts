import { MCPServer } from "./server.ts";

const sceneName = process.env.DOWNDRAFT_SCENE ?? "ocean-survival";
const enableTelemetry = process.env.DOWNDRAFT_TELEMETRY === "1";

const server = new MCPServer({ sceneName, enableTelemetry });
server.start();
