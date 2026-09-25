// ============================================================================
// types.ts — shared contracts for the asset-browser library.
//
// The browser scene is generic over `AssetBrowserItem`: any catalog entry
// with an id/name, a pack (top-level tab), an optional category (filter
// chips), and an optional modelUri for the turntable thumbnail. Games keep
// their richer item types by carrying them in `data` or by satisfying the
// interface structurally (e.g. andrews-sandbox's ContentListItem).
// ============================================================================

import type { PixiUiScene } from "@downdraft/engine/libraries/pixi-ui";
import type { Container } from "pixi.js";

/** One browsable asset card. */
export interface AssetBrowserItem {
  /** Unique id — used as the thumbnail cache key. */
  id: string;
  /** Display name on the card. */
  name: string;
  /** Tab group id (items are grouped into tabs by pack). */
  pack: string;
  /** Tab group label shown in the tab bar. */
  packLabel: string;
  /** Optional filter-chip category id. */
  category?: string;
  /** Model URI fed to the thumbnail backend (fetched, or resolved via the
   *  backend's injected `loadBytes`). Omit for builtin cube/sphere thumbs. */
  modelUri?: string;
  /** Secondary line under the name — defaults to packLabel. */
  sub?: string;
  /** Opaque game payload (the game's own catalog entry type). */
  data?: unknown;
}

/** Which thumbnail the backend should produce for an item. */
export type ThumbKind = "model" | "sphere" | "cube" | "none";

/**
 * Thumbnail backend contract. The WebGL2 `ThumbnailRenderer` is used in the
 * pixi-ui worker; the CPU `SoftwareThumbnailRenderer` is injected on native
 * via `ctx.sceneConfig.createThumbnailRenderer` (or config.thumbnailBackend).
 */
export interface ThumbnailBackend {
  readonly canvasElement: OffscreenCanvas;
  has(contentId: string): boolean;
  loadModelThumb(modelUri: string, contentId: string): Promise<void>;
  loadBuiltinCube(contentId: string): void;
  loadBuiltinSphere(contentId: string): void;
  renderThumb(contentId: string, angle: number): boolean;
  renderPlaceholder(): void;
  dispose(): void;
}

/** Cursor-based builders for the right-hand side panel. The scene owns the
 *  panel chrome (background, selected-item header); the game fills in the
 *  body through `SidePanelUi` helpers — each call appends a control and
 *  advances the internal y cursor. All coordinates are absolute canvas px
 *  (the panel container sits at 0,0), matching pixi-scene conventions. */
export interface SidePanelUi {
  /** A line of text. */
  text(text: string, opts?: { dim?: boolean; accent?: boolean; size?: number; bold?: boolean }): void;
  /** A clickable label styled like `[ Label ]`. */
  button(label: string, onClick: () => void, opts?: { accent?: boolean; danger?: boolean; size?: number }): void;
  /** Labeled horizontal slider. */
  slider(label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void): void;
  /** `[On] / Off` toggle row. */
  toggle(label: string, value: boolean, onChange: (v: boolean) => void): void;
  /** `Label: current` that opens an option list below it. */
  dropdown(label: string, current: string, options: string[], onChange: (v: string) => void): void;
  /** Advance the cursor without drawing. */
  spacer(px: number): void;
}

export interface SidePanelContext<T extends AssetBrowserItem> {
  /** The (0,0-anchored) panel container — draw with absolute coordinates. */
  panel: Container;
  /** Currently selected item (never null when the callback runs). */
  item: T;
  /** The item's badge count (from the `badges`/`spawnCounts` event map). */
  badgeCount: number;
  /** Inner content width in px. */
  width: number;
  /** Cursor-based control builders. */
  ui: SidePanelUi;
  /** Re-invoke the sidePanel callback — call after mutating settings state
   *  so toggles/dropdowns reflect the new values. */
  rebuild(): void;
}

export interface AssetBrowserHandlers<T extends AssetBrowserItem> {
  /** Primary action — double-click, Enter, or the game's side-panel button. */
  onActivate?(item: T): void;
  /** Selection changed (single click / keyboard nav). */
  onSelect?(item: T | null): void;
  /** Close requested — close button, Escape with empty query, etc. */
  onClose?(): void;
  /** Search field focus changed — the game may need to gate its own hotkeys. */
  onSearchFocus?(focused: boolean): void;
}

export interface AssetBrowserConfig<T extends AssetBrowserItem = AssetBrowserItem> {
  /** Header title (default "Asset Browser"). */
  title?: string;
  /** Close button label (default "[X] Close"). */
  closeLabel?: string;
  /** Filter chips row. Omit for no category row. */
  categories?: { id: string; label: string }[];
  /** Extra sort modes. "name" (A→Z) is always available; any additional mode
   *  sorts descending by the item's badge count (see the `badges` event). */
  sortModes?: { id: string; label: string }[];
  /** Card corner badge. Defaults to `×N` from the badge-counts map; return
   *  null/"" to hide. Pass `() => null` to disable badges entirely. */
  badge?: (item: T, count: number) => string | null;
  /** Per-item thumbnail kind override. Default: modelUri → "model",
   *  id containing sphere/ball → "sphere", otherwise "cube". */
  thumbKind?: (item: T) => ThumbKind;
  /** Fields searched by the query box (default: name). */
  searchText?: (item: T) => string;
  /**
   * Right-hand panel body for the selected item. When omitted, a default
   * "click to select" hint is shown. Called with the selected item only;
   * re-invoked on selection changes — call `ui` builders to lay out.
   */
  sidePanel?: (ctx: SidePanelContext<T>) => void;
  /** Hint shown in the side panel when nothing is selected. */
  emptyHint?: string;
  /** Optional left footer buttons (e.g. "[Clear All Props]"). */
  footerButtons?: { label: string; color?: number; onClick: () => void }[];
  /** Right footer text — receives the sum of all badge counts (default
   *  `Total: N`). */
  footerRight?: (totalBadgeCount: number) => string;
  /** Cap on instantiated cards (default 200). */
  maxCards?: number;
  /** When true, a single click selects AND activates the card (default
   *  false — click selects, double-click/Enter activates). */
  activateOnSingleClick?: boolean;
  /** Stats key that drives visibility (default "showBrowser"). */
  visibleStat?: string;
  /** Override thumbnail backend construction (else sceneConfig factory,
   *  else the WebGL2 renderer). */
  thumbnailBackend?: (size: number) => ThumbnailBackend;
}

/** The scene handle — a PixiUiScene plus imperative helpers for in-process
 *  hosts (native) that don't go through the stats/event bridge. */
export interface AssetBrowserScene<T extends AssetBrowserItem = AssetBrowserItem> extends PixiUiScene {
  /** Replace the item catalog (also reachable via the `items`/`contentList` event). */
  setItems(items: T[]): void;
  /** Replace the badge-count map (also reachable via `badges`/`spawnCounts` event). */
  setBadges(counts: Record<string, number>): void;
  /** Replace the category filter chips at runtime (e.g. derived from items). */
  setCategories(cats: { id: string; label: string }[]): void;
  /** Show/hide the browser (also driven by `stats[visibleStat]`). */
  setVisible(show: boolean): void;
  /** Whether the browser overlay is currently visible. */
  isVisible(): boolean;
  /** Currently selected item, if any. */
  getSelected(): T | null;
}
