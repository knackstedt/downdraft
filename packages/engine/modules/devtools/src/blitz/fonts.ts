// ============================================================================
// fonts.ts — bind the host's real system fonts into the devtools dock doc.
//
// The OSR rasterizer ships a single embedded DejaVu Sans as the fallback for
// every generic family — legible, but `monospace` resolves to it too, so the
// console/REPL/tree read as proportional sans. Same fix as cruiser's
// libraries/app-shell/fonts.ts: resolve the user's actual sans + mono faces
// via fontconfig (fc-match -f %{file}), register them as `ui://` blobs on the
// HtmlUiHost before mount, and emit @font-face rules the dock stylesheet
// binds ahead of the generic fallbacks. Any failure (no fc-match, non-Linux
// host, unreadable file) leaves the embedded fallback in place.
// ============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Resource sink — HtmlUiHost.registerResource, or anything shaped like it. */
type ResourceSink = { registerResource(url: string, bytes: Uint8Array | ArrayBuffer): void };

interface Face { family: string; pattern: string; urlName: string; weight: number }

// Blitz-dom only fetches a @font-face source whose format is detectable —
// either an explicit format() hint or a file extension on the url — so the
// urls carry the resolved file's real extension.
const FACES: Face[] = [
  { family: "DevTools Sans", pattern: "sans-serif", urlName: "sans", weight: 400 },
  { family: "DevTools Sans", pattern: "sans-serif:weight=bold", urlName: "sans-bold", weight: 700 },
  { family: "DevTools Mono", pattern: "monospace", urlName: "mono", weight: 400 },
  { family: "DevTools Mono", pattern: "monospace:weight=bold", urlName: "mono-bold", weight: 700 },
];

/** `fc-match -f %{file}` for a fontconfig pattern; null when fc-match is
 *  absent or the match isn't a font file Blitz can load. */
function fcFontFile(pattern: string): string | null {
  try {
    const p = execFileSync("fc-match", ["-f", "%{file}", pattern], { timeout: 5000 }).toString().trim();
    return /\.(ttf|otf|woff2?)$/i.test(p) ? p : null;
  } catch {
    return null;
  }
}

function fontExt(path: string): string {
  return path.match(/\.(ttf|otf|woff2?)$/i)?.[0] ?? ".ttf";
}

/**
 * Register system sans + mono faces as `ui://` resources and return the
 * @font-face CSS to prepend to the dock stylesheet. Returns "" when nothing
 * registered — the stylesheet's named families then fail to resolve and the
 * generic fallbacks (embedded DejaVu) apply.
 *
 * Call before mount — the doc backend applies resources synchronously and in
 * order, so the first doc resolve sees them.
 */
export function registerDevtoolsFonts(sink: ResourceSink): string {
  try {
    // Both weights of a family are required: a 700 rule pointing at the
    // regular file keeps bold text in-family instead of falling back.
    const files = new Map<string, string>();
    for (const f of FACES) files.set(f.urlName, fcFontFile(f.pattern) ?? "");
    if (!files.get("sans")) return "";
    if (!files.get("mono")) files.set("mono", files.get("sans")!);
    if (!files.get("sans-bold")) files.set("sans-bold", files.get("sans")!);
    if (!files.get("mono-bold")) files.set("mono-bold", files.get("mono")!);
    let css = "";
    for (const f of FACES) {
      const file = files.get(f.urlName)!;
      const url = `ui://devtools-fonts/${f.urlName}${fontExt(file)}`;
      sink.registerResource(url, readFileSync(file));
      css += `@font-face { font-family:'${f.family}'; font-weight:${f.weight}; src:url('${url}'); }\n`;
    }
    return css;
  } catch {
    // fc-match absent / unreadable font file — the embedded fallback applies.
    return "";
  }
}
