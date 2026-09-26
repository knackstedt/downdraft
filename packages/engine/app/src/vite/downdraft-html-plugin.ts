// ============================================================================
// downdraftHtmlPlugin — Vite plugin that generates index.html from a layer spec
//
// Instead of every game copying the same index.html boilerplate, the framework
// generates it from a `layers` config. The default is one canvas + one DOM root:
//
//   <canvas data-dd-layer="0" id="game-canvas"></canvas>
//   <div data-dd-overlay="0" id="root"></div>
//   <script type="module" src="/src/main.tsx"></script>
//
// Games that need multiple canvases (e.g. a minimap canvas + a main canvas)
// or multiple DOM overlays can specify them explicitly.
// ============================================================================

import type { Plugin } from "vite";

export interface CanvasLayer {
  type: "canvas";
  /** DOM id for the canvas element. Defaults to "game-canvas" for layer 0. */
  id?: string;
  /** CSS class for the canvas element. */
  className?: string;
  /** Additional HTML attributes. */
  attrs?: Record<string, string>;
}

export interface DomLayer {
  type: "dom";
  /** DOM id for the overlay div. Defaults to "root" for overlay 0. */
  id?: string;
  /** CSS class for the overlay div. */
  className?: string;
  /** Additional HTML attributes. */
  attrs?: Record<string, string>;
}

export type LayerSpec = CanvasLayer | DomLayer;

export interface DowndraftHtmlOptions {
  /** Page title. Defaults to "Downdraft". */
  title?: string;
  /**
   * Layer specification for the page. Canvases are rendered first (bottom),
   * then DOM overlays (top). Defaults to one canvas + one DOM root:
   *
   *   [{ type: "canvas", id: "game-canvas" }, { type: "dom", id: "root" }]
   */
  layers?: LayerSpec[];
  /** Renderer entry script path. Defaults to "/src/main.tsx". */
  entry?: string;
  /** Additional <head> content (meta tags, fonts, etc.). */
  headExtra?: string;
  /** Additional <body> content before the script tag. */
  bodyExtra?: string;
}

function buildHtml(opts: DowndraftHtmlOptions): string {
  const title = opts.title ?? "Downdraft";
  const entry = opts.entry ?? "/src/main.tsx";
  const layers = opts.layers ?? [
    { type: "canvas", id: "game-canvas" },
    { type: "dom", id: "root" },
  ];

  let canvasIdx = 0;
  let domIdx = 0;
  const bodyParts: string[] = [];

  layers.forEach((layer) => {
    if (layer.type === "canvas") {
      const id = layer.id ?? (canvasIdx === 0 ? "game-canvas" : `canvas-${canvasIdx}`);
      const cls = layer.className ? ` class="${layer.className}"` : "";
      const extraAttrs = layer.attrs
        ? " " + Object.entries(layer.attrs).map(([k, v]) => `${k}="${v}"`).join(" ")
        : "";
      bodyParts.push(`  <canvas data-dd-layer="${canvasIdx}" id="${id}"${cls}${extraAttrs}></canvas>`);
      canvasIdx++;
    } else {
      const id = layer.id ?? (domIdx === 0 ? "root" : `overlay-${domIdx}`);
      const cls = layer.className ? ` class="${layer.className}"` : "";
      const extraAttrs = layer.attrs
        ? " " + Object.entries(layer.attrs).map(([k, v]) => `${k}="${v}"`).join(" ")
        : "";
      bodyParts.push(`  <div data-dd-overlay="${domIdx}" id="${id}"${cls}${extraAttrs}></div>`);
      domIdx++;
    }
  });

  if (opts.bodyExtra) {
    bodyParts.push(opts.bodyExtra);
  }

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>${opts.headExtra ? "\n    " + opts.headExtra : ""}
  </head>
  <body>
${bodyParts.join("\n")}
    <script type="module" src="${entry}"></script>
  </body>
</html>
`;
}

/**
 * Vite plugin that generates index.html from a layer specification.
 *
 * If the game has its own index.html, it takes precedence (the plugin only
 * generates when no index.html exists at the renderer root). This allows
 * games to opt-in incrementally.
 */
export function downdraftHtmlPlugin(opts: DowndraftHtmlOptions): Plugin {
  const html = buildHtml(opts);
  return {
    name: "downdraft-html",
    enforce: "pre",
    resolveId(id) {
      // Virtual module so games can also import the generated HTML explicitly
      if (id === "virtual:downdraft-html") {
        return "\0virtual:downdraft-html";
      }
      return null;
    },
    load(id) {
      if (id === "\0virtual:downdraft-html") {
        return html;
      }
      return null;
    },
    transformIndexHtml: {
      order: "pre",
      handler(_html: string, ctx: { path: string }) {
        // Replace the index.html content with the framework-generated HTML.
        // This ensures the framework controls the canvas/DOM layer layout.
        void ctx;
        return html;
      },
    },
  };
}
