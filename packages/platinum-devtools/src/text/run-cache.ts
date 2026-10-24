// ============================================================================
// run-cache.ts — styled text → shape metrics + atlas bitmaps.
//
// Two cache layers:
//   getRun()   — shape info for a full run: advance, per-boundary cluster
//                offsets (caret/wrap math), font metrics, baseline. Cheap
//                (harfbuzz only), keyed by face|size|text.
//   getChunk() — rasterized atlas bitmap for an arbitrary substring. Lines
//                draw slices of runs, so bitmaps key on the substring they
//                actually rasterize.
//
// Baseline: calibrated per (face, size) by scanning the ink bottom of an
// "H" probe — that row IS the baseline inside the bitmap. Runs draw at
// `baseline - baselineInBitmap`, keeping mixed faces/sizes aligned without
// trusting cosmic's internal line metrics.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { TextAtlas, type AtlasRegion } from "./atlas";
import { FtRasterizer } from "./ft";
import { TextShaper } from "./shaper";

const log = createLogger();

export interface FaceDef {
  /** Canonical key, e.g. "inter:400:normal". */
  key: string;
  /** Font file path for ft_shim_init. */
  path: string;
  /** Raw font bytes for harfbuzzjs. */
  data: Uint8Array;
}

export interface RunShape {
  /** Total advance in px. */
  advance: number;
  /** UTF-16 boundary → x offset (length text.length + 1). */
  clusterOffsets: Float32Array;
  /** Font ascent/descent in px at this size. */
  ascent: number;
  descent: number;
  /** Baseline distance from the top of chunk bitmaps at this face+size. */
  baselineInBitmap: number;
}

export interface ChunkBitmap {
  /** Atlas region (null for blank text — advance only). */
  region: AtlasRegion | null;
  /** Leading-space advance — the bitmap's left edge is at `penX - padX`
   *  (the rasterized string is " text ", so bitmap x=0 is the leading
   *  space's pen origin, not the run's). */
  padX: number;
  /** Left ink edge in run pen space (inkMinX minus the pad margin).
   *  Informational — negative means overhang left of the pen origin. */
  inkX: number;
  /** Bitmap dims in px. */
  w: number;
  h: number;
  baselineInBitmap: number;
}

export class RunCache {
  private ft = new FtRasterizer();
  private shaper = new TextShaper();
  private faces = new Map<string, FaceDef>();
  private handles = new Map<string, bigint>();
  private baselines = new Map<string, number>();
  private spaceAdvances = new Map<string, number>();
  private runs = new Map<string, RunShape>();
  private chunks = new Map<string, ChunkBitmap>();
  private lru = new Map<string, number>();
  private tick = 0;

  constructor(readonly atlas: TextAtlas) {}

  get ready(): boolean {
    return this.ft.available && this.shaper.ready;
  }

  async init(): Promise<void> {
    await this.shaper.init();
  }

  registerFace(def: FaceDef): void {
    this.faces.set(def.key, def);
    this.shaper.addFace(def.key, def.data);
  }

  private ftHandle(key: string): bigint {
    let h = this.handles.get(key);
    if (h !== undefined) return h;
    const def = this.faces.get(key);
    if (!def) log.warn("run-cache", `unregistered face ${key}`);
    h = def ? this.ft.face(def.path) : 0n;
    this.handles.set(key, h);
    return h;
  }

  private touch(k: string): void {
    this.lru.set(k, ++this.tick);
  }

  private calibrate(face: string, sizePx: number): number {
    const ck = `${face}@${sizePx}`;
    const cached = this.baselines.get(ck);
    if (cached !== undefined) return cached;
    let baseline = Math.round(sizePx * 0.8);
    // Cold FontSystem handles can return an empty first render — retry once
    // before falling back to the metric estimate.
    let probe = this.ft.render(this.ftHandle(face), "H", sizePx);
    if (!probe) probe = this.ft.render(this.ftHandle(face), "H", sizePx);
    if (probe) {
      // Bottom-most ink row = baseline (glyphs sit on it).
      outer:
      for (let y = probe.height - 1; y >= 0; y--) {
        for (let x = 0; x < probe.width; x++) {
          if (probe.data[(y * probe.width + x) * 4 + 3]! > 0) {
            baseline = y + 1;
            break outer;
          }
        }
      }
    }
    this.baselines.set(ck, baseline);
    return baseline;
  }

  /** Advance of a single space — the margin the padded raster adds on the
   *  left. Shaped space advance is context-free (it's the first glyph), so
   *  ft_shim_measure(" ") is exact. */
  private spaceAdvance(face: string, handle: bigint, size: number): number {
    const ck = `${face}@${size}`;
    const hit = this.spaceAdvances.get(ck);
    if (hit !== undefined) return hit;
    const adv = Math.max(0, this.ft.measure(handle, " ", size));
    this.spaceAdvances.set(ck, adv);
    return adv;
  }

  /** Shape metrics for a full run. */
  getRun(face: string, sizePx: number, text: string): RunShape | null {
    if (!text) return null;
    // See getChunk — never cache results for unregistered faces.
    if (!this.faces.has(face)) return null;
    const size = Math.max(1, Math.round(sizePx));
    const ck = `r|${face}@${size}\x00${text}`;
    const hit = this.runs.get(ck);
    if (hit) { this.touch(ck); return hit; }
    if (!this.ready) return null;

    const shaped = this.shaper.shape(face, text, size);
    const m = this.shaper.metrics(face, size);
    const advance = shaped?.advance ?? Math.max(0, this.ft.measure(this.ftHandle(face), text, size));
    const shape: RunShape = {
      advance,
      clusterOffsets: shaped?.clusterOffsets ?? monotonicOffsets(text.length),
      ascent: m.ascent,
      descent: m.descent,
      baselineInBitmap: this.calibrate(face, size),
    };
    this.runs.set(ck, shape);
    this.touch(ck);
    this.evictIfNeeded();
    return shape;
  }

  /** Rasterized atlas bitmap for a substring (or full run). */
  getChunk(face: string, sizePx: number, text: string): ChunkBitmap | null {
    if (!text) return null;
    // Unregistered face — return null WITHOUT caching: during boot there's a
    // window where the shaper is ready but loadFaces() hasn't finished, and a
    // cached empty chunk here would poison the face for the whole session.
    if (!this.faces.has(face)) return null;
    const size = Math.max(1, Math.round(sizePx));
    const ck = `c|${face}@${size}\x00${text}`;
    const hit = this.chunks.get(ck);
    if (hit) {
      if (hit.region && hit.region.generation !== this.atlas.generation) {
        this.chunks.delete(ck);
      } else {
        this.touch(ck);
        return hit;
      }
    }
    if (!this.ready) return null;

    const baseline = this.calibrate(face, size);
    // Rasterize with one space of margin each side. The shim's bitmap starts
    // at pen 0 and ends at ceil(advance) — italic/quote ink that overhangs
    // the advance is silently clipped; a leading space gives the left
    // overhang somewhere to land (shaped penX shifts by the space advance,
    // which inkMinX on the padded string accounts for), a trailing space
    // does the same on the right. Costs a few px of bitmap width per chunk.
    const raster = ` ${text} `;
    const handle = this.ftHandle(face);
    const bmp = this.ft.render(handle, raster, size);
    if (!bmp || bmp.width === 0 || bmp.height === 0) {
      const empty: ChunkBitmap = { region: null, padX: 0, inkX: 0, w: 0, h: 0, baselineInBitmap: baseline };
      this.chunks.set(ck, empty);
      this.touch(ck);
      return empty;
    }
    let region = this.atlas.alloc(bmp.width, bmp.height);
    if (!region) {
      this.atlas.reset();
      region = this.atlas.alloc(bmp.width, bmp.height);
      if (!region) {
        log.warn("run-cache", `chunk too large for atlas: ${bmp.width}x${bmp.height}`);
        return null;
      }
    }
    this.atlas.upload(region, bmp.data);
    const padX = this.spaceAdvance(face, handle, size);
    const chunk: ChunkBitmap = {
      region,
      padX,
      inkX: inkMinX(this.shaper, face, size, raster) - padX,
      w: bmp.width,
      h: bmp.height,
      baselineInBitmap: baseline,
    };
    this.chunks.set(ck, chunk);
    this.touch(ck);
    this.evictIfNeeded();
    return chunk;
  }

  /** Cap cache growth — drop least-recently-used entries. */
  private evictIfNeeded(): void {
    const LIMIT = 4096;
    if (this.runs.size + this.chunks.size <= LIMIT) return;
    const entries = [...this.lru.entries()].sort((a, b) => a[1] - b[1]);
    const drop = Math.floor(LIMIT / 4);
    for (let i = 0; i < drop && i < entries.length; i++) {
      const k = entries[i]![0];
      this.runs.delete(k);
      this.chunks.delete(k);
      this.lru.delete(k);
    }
  }

  get stats(): { runs: number; chunks: number } {
    return { runs: this.runs.size, chunks: this.chunks.size };
  }

  dispose(): void {
    this.runs.clear();
    this.chunks.clear();
    this.baselines.clear();
    this.spaceAdvances.clear();
    this.lru.clear();
    this.ft.dispose();
    this.shaper.dispose();
  }
}

function monotonicOffsets(len: number): Float32Array {
  const o = new Float32Array(len + 1);
  for (let i = 0; i <= len; i++) o[i] = i;
  return o;
}

/** Left ink edge of a substring in pen space. Negative = overhang left of
 *  the pen origin (italic f, quotes). Derived from hb glyph extents. */
function inkMinX(shaper: TextShaper, face: string, sizePx: number, text: string): number {
  const f = shaper.font(face);
  if (!f) return 0;
  const shaped = shaper.shapeGlyphs(face, text, sizePx);
  if (!shaped || shaped.glyphs.length === 0) return 0;
  f.font.setScale(sizePx, sizePx);
  let minX = Infinity;
  shaped.glyphs.forEach((g) => {
    const ext = f.font.glyphExtents(g.glyphId);
    if (ext) minX = Math.min(minX, g.penX + ext.xBearing);
  });
  return minX === Infinity ? 0 : minX;
}
