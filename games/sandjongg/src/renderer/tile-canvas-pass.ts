// ============================================================================
// TileCanvasPass — draws tiles, selection, path-glow, and crumble animations
// on a Canvas2D overlay. All glyphs are procedurally drawn (no external assets).
// ============================================================================

import { MAX_LAYERS } from "../shared/constants";
import { getElement } from "../shared/elements";
import type { BoardPoint, Path } from "../shared/types";

export interface TileCanvasState {
  /** Board elements from SAB: Int32Array of element per slot, -1 = empty.
   *  Indexed as boardElements[(col + row*cols) * MAX_LAYERS + layer]. */
  boardElements: Int32Array;
  boardCols: number;
  boardRows: number;
  /** Number of layers in the board (1 = flat). */
  boardLayers: number;
  /** Currently selected tile (or null). */
  selected: { col: number; row: number; layer: number } | null;
  /** Hint tiles to highlight (or null). */
  hint: { a: BoardPoint; b: BoardPoint } | null;
  /** Active path animation (fades over time). */
  pathAnim: { path: Path; startTime: number; element: number } | null;
  /** Active crumble animations. */
  crumbleAnims: { col: number; row: number; element: number; startTime: number }[];
  /** Active failed-match animations (red flash). */
  failAnims: { col: number; row: number; layer: number; startTime: number }[];
}

export class TileCanvasPass {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Tile pixel size on screen (computed from canvas size + board dims). */
  private tilePx = 48;
  /** Board pixel offset (top-left of board on canvas). */
  private boardOffsetX = 0;
  private boardOffsetY = 0;
  state: TileCanvasState;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.state = {
      boardElements: new Int32Array(0),
      boardCols: 0,
      boardRows: 0,
      boardLayers: 1,
      selected: null,
      hint: null,
      pathAnim: null,
      crumbleAnims: [],
      failAnims: [],
    };
  }

  getCanvas(): HTMLCanvasElement { return this.canvas; }

  /** Compute tile pixel size and board offset from canvas dimensions. */
  computeLayout(canvasW: number, canvasH: number): void {
    const { boardCols, boardRows } = this.state;
    if (boardCols === 0 || boardRows === 0) return;
    // Reserve top 60% of canvas for board, bottom 40% for sand pit.
    // The top HUD (level/score/combo/tiles) occupies roughly the top 70px,
    // so the board area starts below it to avoid overlap.
    const HUD_TOP_MARGIN = 70;
    const boardAreaTop = HUD_TOP_MARGIN;
    const boardAreaH = canvasH * 0.6 - boardAreaTop;
    const maxTileW = canvasW / boardCols;
    const maxTileH = boardAreaH / boardRows;
    this.tilePx = Math.floor(Math.min(maxTileW, maxTileH, 64));
    const boardW = this.tilePx * boardCols;
    const boardH = this.tilePx * boardRows;
    this.boardOffsetX = Math.floor((canvasW - boardW) / 2);
    this.boardOffsetY = Math.floor(boardAreaTop + (boardAreaH - boardH) / 2) + 8;
  }

  /** Convert screen pixel coords to tile coords (or null if outside board).
   *  Returns the topmost occupied layer at that position. */
  hitTest(px: number, py: number): { col: number; row: number; layer: number } | null {
    const col = Math.floor((px - this.boardOffsetX) / this.tilePx);
    const row = Math.floor((py - this.boardOffsetY) / this.tilePx);
    if (col < 0 || col >= this.state.boardCols || row < 0 || row >= this.state.boardRows) return null;
    // Check if the click is within the tile bounds (not in the gap between tiles).
    const tileX = this.boardOffsetX + col * this.tilePx;
    const tileY = this.boardOffsetY + row * this.tilePx;
    if (px < tileX || px >= tileX + this.tilePx || py < tileY || py >= tileY + this.tilePx) return null;
    // Find the topmost occupied layer at this position.
    const { boardElements, boardCols, boardLayers } = this.state;
    for (let layer = boardLayers - 1; layer >= 0; layer--) {
      const el = boardElements[(col + row * boardCols) * MAX_LAYERS + layer];
      if (el >= 0) return { col, row, layer };
    }
    return null;
  }

  /** Convert tile coords to screen pixel center. */
  tileToPixel(col: number, row: number): { x: number; y: number } {
    return {
      x: this.boardOffsetX + col * this.tilePx + this.tilePx / 2,
      y: this.boardOffsetY + row * this.tilePx + this.tilePx / 2,
    };
  }

  /** Main draw call — called every frame by the renderer. */
  draw(): void {
    const ctx = this.ctx;
    const { boardElements, boardCols, boardRows, boardLayers, selected, hint, pathAnim, crumbleAnims, failAnims } = this.state;
    const now = performance.now();

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (boardCols === 0 || boardRows === 0) return;

    // Determine the selected tile's element for same-element highlighting.
    let selectedElement = -1;
    if (selected) {
      selectedElement = boardElements[(selected.col + selected.row * boardCols) * MAX_LAYERS + selected.layer];
    }

    // No board background — let the WebGPU sand canvas show through.
    // Draw tiles layer by layer (bottom to top), with a pseudo-3D offset
    // for higher layers so stacking is visually clear.
    const layerOffset = Math.max(4, this.tilePx * 0.12);
    for (let layer = 0; layer < boardLayers; layer++) {
      const offset = layer * layerOffset;
      for (let r = 0; r < boardRows; r++) {
        for (let c = 0; c < boardCols; c++) {
          const el = boardElements[(c + r * boardCols) * MAX_LAYERS + layer];
          if (el < 0) continue;

          const x = this.boardOffsetX + c * this.tilePx - offset;
          const y = this.boardOffsetY + r * this.tilePx - offset;
          const size = this.tilePx - 2;
          const elDef = getElement(el);

          // Tile shadow for stacked layers.
          if (layer > 0) {
            ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
            ctx.beginPath();
            ctx.roundRect(x + 3, y + 3, size, size, 4);
            ctx.fill();
          }

          // Tile background (slightly transparent so sand is visible behind).
          ctx.globalAlpha = 0.92;
          ctx.fillStyle = elDef.color;
          ctx.beginPath();
          ctx.roundRect(x + 1, y + 1, size, size, 4);
          ctx.fill();
          ctx.globalAlpha = 1.0;

          // Tile border.
          ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
          ctx.lineWidth = 1;
          ctx.stroke();

          // Element glyph.
          this.drawGlyph(ctx, elDef.glyph, x + size / 2, y + size / 2, size * 0.6, elDef.glyphColor);

          // Same-element highlight: when a tile is selected, subtly outline
          // all other tiles of the same element to help find matches.
          if (selected && selectedElement >= 0 && el === selectedElement &&
              !(selected.col === c && selected.row === r && selected.layer === layer)) {
            const pulse = 0.3 + 0.2 * Math.sin(now / 300);
            ctx.strokeStyle = `rgba(255, 255, 255, ${pulse})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(x + 1, y + 1, size, size, 4);
            ctx.stroke();
          }

          // Selection highlight.
          if (selected && selected.col === c && selected.row === r && selected.layer === layer) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.roundRect(x + 1, y + 1, size, size, 4);
            ctx.stroke();
          }

          // Hint highlight (pulsing).
          if (hint && (
            (hint.a.col === c && hint.a.row === r && hint.a.layer === layer) ||
            (hint.b.col === c && hint.b.row === r && hint.b.layer === layer)
          )) {
            const pulse = 0.5 + 0.5 * Math.sin(now / 200);
            ctx.strokeStyle = `rgba(255, 255, 0, ${0.5 + 0.5 * pulse})`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.roundRect(x + 1, y + 1, size, size, 4);
            ctx.stroke();
          }
        }
      }
    }

    // Draw path animation (glowing connect line).
    if (pathAnim) {
      const elapsed = now - pathAnim.startTime;
      const duration = 600;
      if (elapsed < duration) {
        const alpha = 1 - elapsed / duration;
        const points = pathAnim.path.points;
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.lineWidth = 4;
        ctx.shadowColor = getElement(pathAnim.element).color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
          const p = this.tileToPixel(points[i].col, points[i].row);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    // Draw crumble animations (flash + fade).
    this.state.crumbleAnims = crumbleAnims.filter((a) => {
      const elapsed = now - a.startTime;
      const duration = 400;
      if (elapsed >= duration) return false;
      const alpha = 1 - elapsed / duration;
      const x = this.boardOffsetX + a.col * this.tilePx;
      const y = this.boardOffsetY + a.row * this.tilePx;
      const size = this.tilePx - 2;
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.8})`;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1, size, size, 4);
      ctx.fill();
      return true;
    });

    // Draw failed-match animations (red flash + fade).
    this.state.failAnims = failAnims.filter((a) => {
      const elapsed = now - a.startTime;
      const duration = 300;
      if (elapsed >= duration) return false;
      const alpha = 1 - elapsed / duration;
      const offset = a.layer * layerOffset;
      const x = this.boardOffsetX + a.col * this.tilePx - offset;
      const y = this.boardOffsetY + a.row * this.tilePx - offset;
      const size = this.tilePx - 2;
      ctx.strokeStyle = `rgba(255, 60, 60, ${alpha})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1, size, size, 4);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 60, 60, ${alpha * 0.3})`;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1, size, size, 4);
      ctx.fill();
      return true;
    });
  }

  /** Draw a procedural element glyph. */
  private drawGlyph(ctx: CanvasRenderingContext2D, glyph: string, cx: number, cy: number, size: number, color: string): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    const s = size / 2;

    switch (glyph) {
      case "flame":
        ctx.beginPath();
        ctx.moveTo(cx, cy - s);
        ctx.quadraticCurveTo(cx + s * 0.6, cy - s * 0.2, cx + s * 0.3, cy + s * 0.5);
        ctx.quadraticCurveTo(cx, cy + s, cx - s * 0.3, cy + s * 0.5);
        ctx.quadraticCurveTo(cx - s * 0.6, cy - s * 0.2, cx, cy - s);
        ctx.fill();
        break;
      case "drop":
        ctx.beginPath();
        ctx.moveTo(cx, cy - s);
        ctx.quadraticCurveTo(cx + s, cy, cx + s * 0.5, cy + s * 0.5);
        ctx.quadraticCurveTo(cx, cy + s, cx - s * 0.5, cy + s * 0.5);
        ctx.quadraticCurveTo(cx - s, cy, cx, cy - s);
        ctx.fill();
        break;
      case "mountain":
        ctx.beginPath();
        ctx.moveTo(cx - s, cy + s * 0.7);
        ctx.lineTo(cx - s * 0.3, cy - s * 0.3);
        ctx.lineTo(cx, cy + s * 0.2);
        ctx.lineTo(cx + s * 0.4, cy - s * 0.6);
        ctx.lineTo(cx + s, cy + s * 0.7);
        ctx.closePath();
        ctx.fill();
        break;
      case "swirl":
        ctx.beginPath();
        for (let i = 0; i <= 360; i += 5) {
          const a = (i * Math.PI) / 180;
          const r = s * (0.3 + 0.7 * (i / 360));
          const x = cx + Math.cos(a * 2) * r;
          const y = cy + Math.sin(a * 2) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        break;
      case "bolt":
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.2, cy - s);
        ctx.lineTo(cx - s * 0.3, cy);
        ctx.lineTo(cx + s * 0.1, cy);
        ctx.lineTo(cx - s * 0.2, cy + s);
        ctx.lineTo(cx + s * 0.4, cy - s * 0.1);
        ctx.lineTo(cx, cy - s * 0.1);
        ctx.closePath();
        ctx.fill();
        break;
      case "snowflake":
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * s, cy + Math.sin(a) * s);
          ctx.stroke();
          // Small branches.
          const bx = cx + Math.cos(a) * s * 0.6;
          const by = cy + Math.sin(a) * s * 0.6;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(a + 0.5) * s * 0.3, by + Math.sin(a + 0.5) * s * 0.3);
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(a - 0.5) * s * 0.3, by + Math.sin(a - 0.5) * s * 0.3);
          ctx.stroke();
        }
        break;
      case "leaf":
        ctx.beginPath();
        ctx.moveTo(cx - s, cy);
        ctx.quadraticCurveTo(cx, cy - s, cx + s, cy);
        ctx.quadraticCurveTo(cx, cy + s, cx - s, cy);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx - s, cy);
        ctx.lineTo(cx + s, cy);
        ctx.stroke();
        break;
      case "ingot":
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.8, cy + s * 0.5);
        ctx.lineTo(cx - s * 0.5, cy - s * 0.3);
        ctx.lineTo(cx + s * 0.5, cy - s * 0.3);
        ctx.lineTo(cx + s * 0.8, cy + s * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.3)";
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.5, cy - s * 0.3);
        ctx.lineTo(cx + s * 0.5, cy - s * 0.3);
        ctx.stroke();
        break;
      case "sun":
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * s * 0.6, cy + Math.sin(a) * s * 0.6);
          ctx.lineTo(cx + Math.cos(a) * s, cy + Math.sin(a) * s);
          ctx.stroke();
        }
        break;
      case "crescent":
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(cx + s * 0.3, cy, s * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        break;
      case "bubble":
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.3)";
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "hexagon":
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3 - Math.PI / 6;
          const x = cx + Math.cos(a) * s * 0.8;
          const y = cy + Math.sin(a) * s * 0.8;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        break;
      case "oil":
        // Dark viscous droplet with a sheen highlight.
        ctx.beginPath();
        ctx.moveTo(cx, cy - s);
        ctx.quadraticCurveTo(cx + s, cy, cx + s * 0.5, cy + s * 0.6);
        ctx.quadraticCurveTo(cx, cy + s, cx - s * 0.5, cy + s * 0.6);
        ctx.quadraticCurveTo(cx - s, cy, cx, cy - s);
        ctx.fill();
        // Sheen highlight (top-left).
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
        ctx.beginPath();
        ctx.ellipse(cx - s * 0.25, cy - s * 0.25, s * 0.18, s * 0.1, -0.6, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "powder":
        // Cluster of small granular dots.
        const powderDots = [
          [-0.4, -0.3, 0.22], [0.3, -0.4, 0.18], [0.45, 0.1, 0.2],
          [-0.1, 0.1, 0.25], [-0.45, 0.35, 0.16], [0.15, 0.45, 0.18],
        ];
        for (const [dx, dy, r] of powderDots) {
          ctx.beginPath();
          ctx.arc(cx + dx * s, cy + dy * s, r * s, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case "dynamite":
        // Stick of dynamite with a fuse + spark on top.
        ctx.fillRect(cx - s * 0.25, cy - s * 0.3, s * 0.5, s * 1.0);
        // Fuse line.
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy - s * 0.3);
        ctx.quadraticCurveTo(cx + s * 0.3, cy - s * 0.6, cx + s * 0.15, cy - s * 0.85);
        ctx.stroke();
        // Spark at fuse tip.
        ctx.beginPath();
        ctx.arc(cx + s * 0.15, cy - s * 0.85, s * 0.12, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "plasma":
        // Glowing energy orb with concentric rings.
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.75, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.25, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "popcorn":
        // Fluffy popped kernel — cluster of bumps.
        const popBumps = [
          [-0.3, -0.2, 0.4], [0.3, -0.25, 0.38], [0.0, 0.05, 0.45],
          [-0.35, 0.3, 0.32], [0.35, 0.3, 0.34],
        ];
        for (const [dx, dy, r] of popBumps) {
          ctx.beginPath();
          ctx.arc(cx + dx * s, cy + dy * s, r * s, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case "salt":
        // Crystalline grains — small rotated squares.
        ctx.lineWidth = 1;
        const saltCrystals = [
          [-0.35, -0.3, 0.18], [0.3, -0.35, 0.16], [0.4, 0.2, 0.2],
          [-0.1, 0.05, 0.22], [-0.3, 0.35, 0.15], [0.1, 0.4, 0.16],
        ];
        for (const [dx, dy, r] of saltCrystals) {
          ctx.save();
          ctx.translate(cx + dx * s, cy + dy * s);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-r * s, -r * s, r * s * 2, r * s * 2);
          ctx.restore();
        }
        break;
      case "frost":
        // Jagged frost crystal — 6 sharp spikes with side branches.
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * s, cy + Math.sin(a) * s);
          ctx.stroke();
          // Jagged side branches.
          for (const dist of [0.4, 0.7]) {
            const bx = cx + Math.cos(a) * s * dist;
            const by = cy + Math.sin(a) * s * dist;
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + Math.cos(a + 1.05) * s * 0.22, by + Math.sin(a + 1.05) * s * 0.22);
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + Math.cos(a - 1.05) * s * 0.22, by + Math.sin(a - 1.05) * s * 0.22);
            ctx.stroke();
          }
        }
        break;
    }
    ctx.restore();
  }
}
