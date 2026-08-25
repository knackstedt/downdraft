import { writeFileSync } from "node:fs";
import type { Plugin } from "vite";
import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";

/**
 * Vite plugin that provides a file-write endpoint for the renderer.
 * The renderer is sandboxed (no fs access), so it POSTs sidecar content
 * to this endpoint, which runs in the Vite dev server (Node process).
 *
 * POST /__ddmeta_write__?path=<absolute-path>
 * Body: file contents (text)
 */
function sidecarWriterPlugin(): Plugin {
  return {
    name: "ddmeta-writer",
    configureServer(server) {
      server.middlewares.use("/__ddmeta_write__", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          res.statusCode = 400;
          res.end("Missing 'path' query param");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          try {
            const content = Buffer.concat(chunks).toString("utf-8");
            writeFileSync(filePath, content, "utf-8");
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: true, path: filePath }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    },
  };
}

export default createDowndraftViteConfig({
  root: __dirname,
  game: "model-viewer",
  html: {
    title: "Downdraft Model Viewer",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "dom", id: "root" },
    ],
  },
  rendererPlugins: [sidecarWriterPlugin()],
});
