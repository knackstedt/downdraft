// ============================================================================
// scene.ts — generic tabbed asset browser scene for pixi-ui.
//
// Extracted from andrews-sandbox's pixi-scene.tsx (GMod-style spawn browser)
// and generalized: pack tabs, category filter chips, search, a virtualized
// thumbnail card grid, keyboard nav, and a pluggable right-hand side panel.
// Runs both in the pixi-ui worker (Electron, WebGL2 thumbnails) and
// in-process on the native host (software thumbnails via sceneConfig).
//
// Game contract:
//   - items arrive via the `items` (or legacy `contentList`) event, or
//     imperatively via `scene.setItems()`
//   - badge counts via the `badges` (or legacy `spawnCounts`) event, or
//     `scene.setBadges()`
//   - visibility via `stats[visibleStat]` (default "showBrowser") or
//     `scene.setVisible()`
//   - user intent via the config handlers (onActivate/onSelect/onClose/...)
// ============================================================================

import type { PixiUiSceneContext, PixiUiUpdateData } from "@downdraft/engine/libraries/pixi-ui";
import { Container, Graphics, Sprite, Text, Texture, type Application } from "pixi.js";
import { createSidePanelUi } from "./side-panel";
import { ThumbnailRenderer } from "./thumbnail-renderer";
import type {
    AssetBrowserConfig,
    AssetBrowserHandlers,
    AssetBrowserItem,
    AssetBrowserScene,
    ThumbnailBackend,
} from "./types";

// The thumbnail backend is pluggable: the worker uses the WebGL2
// ThumbnailRenderer; the native host injects a software rasterizer via
// ctx.sceneConfig.createThumbnailRenderer (WebGL2 doesn't exist there).
const isNativeRuntime = (): boolean =>
  !!(globalThis as { __nativeHost?: unknown }).__nativeHost;

// ── Colors ──
const C_BG = 0x0a0a14;
const C_PANEL = 0x141428;
const C_PANEL_BORDER = 0x4e9af1;
const C_ACCENT = 0x4e9af1;
const C_TEXT = 0xe0e0e0;
const C_TEXT_DIM = 0x888888;
const C_CARD = 0x1a1a2e;
const C_CARD_SELECTED = 0x2a3a5e;
const C_COUNT = 0x4e9af1;

// ── Layout ──
const THUMB_SIZE = 96;
const CARD_W = 130;
const CARD_H = 160;
const CARD_GAP = 8;
const SETTINGS_W = 300;
const HEADER_H = 44;
const TABS_H = 36;
const FILTERS_H = 32;
const FOOTER_H = 36;
const PADDING = 12;
const FONT = "Segoe UI, Arial, sans-serif";

// ── Textures per card (2D OffscreenCanvas → PIXI Texture) ──
interface CardEntry<T extends AssetBrowserItem> {
  item: T;
  container: Container;
  thumbCanvas: OffscreenCanvas;
  thumbCtx: OffscreenCanvasRenderingContext2D;
  texture: Texture;
  sprite: Sprite;
  nameText: Text;
  countText: Text;
  angle: number;
  modelLoaded: boolean;
  thumbRendered: boolean;
}

const DEFAULT_HINT =
  "Click a card to select.\nDouble-click or press Enter to activate.\n\nKeyboard:\n WASD/Arrows: navigate\n Tab: next pack\n Enter: activate\n Backspace: edit search\n Esc: clear/close";

export function createAssetBrowserScene<T extends AssetBrowserItem>(
  ctx: PixiUiSceneContext,
  config: AssetBrowserConfig<T> = {},
  handlers: AssetBrowserHandlers<T> = {},
): AssetBrowserScene<T> {
  const app: Application = ctx.app;

  const title = config.title ?? "Asset Browser";
  const closeLabel = config.closeLabel ?? "[X] Close";
  const maxCards = config.maxCards ?? 200;
  const visibleStat = config.visibleStat ?? "showBrowser";
  const hasSidePanel = !!config.sidePanel;
  const sidePanelW = hasSidePanel ? SETTINGS_W : 0;
  const hasFilters = !!(config.categories?.length || (config.sortModes?.length ?? 0) > 1);
  const filtersH = hasFilters ? FILTERS_H : 0;
  const searchText = config.searchText ?? ((i: T) => i.name);
  const thumbKind = config.thumbKind ?? ((i: T) =>
    i.modelUri ? "model" : (i.id.includes("sphere") || i.id.includes("ball")) ? "sphere" : "cube");
  const badgeText = config.badge ?? ((item: T, count: number) => `×${count}`);
  const emptyHint = config.emptyHint ?? DEFAULT_HINT;
  const sortModes = config.sortModes ?? [];

  const root = new Container();
  app.stage.addChild(root);

  // ── State ──
  let showBrowser = false;
  let contentItems: T[] = [];
  let badgeCounts: Record<string, number> = {};
  let activePack = "all";
  let searchQuery = "";
  // Text-entry focus: while focused every printable key (incl. WASD) appends
  // to the query; unfocused, WASD/arrows navigate the grid and typing any
  // printable char focuses + appends.
  let searchFocused = false;
  let categoryFilter = "all";
  let sortBy = "name";
  let selectedContentId: string | null = null;
  let scrollY = 0;
  let maxScrollY = 0;
  let cards: CardEntry<T>[] = [];
  let thumbRenderer: ThumbnailBackend | null = null;
  let caretBlink = 0;
  let dragScrolling = false;
  let dragStartY = 0;
  let dragStartScroll = 0;
  let dragMoved = false;

  // ── UI Containers ──
  const backdrop = new Graphics();
  backdrop.visible = false;
  root.addChild(backdrop);

  const browserRoot = new Container();
  browserRoot.visible = false;
  root.addChild(browserRoot);

  const headerBar = new Container();
  browserRoot.addChild(headerBar);

  const tabsBar = new Container();
  browserRoot.addChild(tabsBar);

  const filtersBar = new Container();
  browserRoot.addChild(filtersBar);

  const gridArea = new Container();
  browserRoot.addChild(gridArea);

  const settingsPanel = new Container();
  browserRoot.addChild(settingsPanel);

  const footerBar = new Container();
  browserRoot.addChild(footerBar);

  // ── Pack list (derived from content items) ──
  let packs: Array<{ id: string; label: string }> = [{ id: "all", label: "All" }];

  function derivePacks(): void {
    const map = new Map<string, string>();
    for (const item of contentItems) {
      if (!map.has(item.pack)) map.set(item.pack, item.packLabel);
    }
    packs = [{ id: "all", label: "All" }];
    for (const [id, label] of map) packs.push({ id, label });
  }

  // ── Filtered items ──
  function getFilteredItems(): T[] {
    let items = contentItems;
    if (activePack !== "all") items = items.filter((i) => i.pack === activePack);
    if (categoryFilter !== "all") items = items.filter((i) => i.category === categoryFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter((i) => searchText(i).toLowerCase().includes(q));
    }
    const sorted = [...items];
    if (sortBy === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else sorted.sort((a, b) => (badgeCounts[b.id] ?? 0) - (badgeCounts[a.id] ?? 0));
    return sorted;
  }

  // ── Layout dimensions ──
  function getGridWidth(): number {
    return app.screen.width - sidePanelW - PADDING * 3;
  }
  function getGridHeight(): number {
    return app.screen.height - HEADER_H - TABS_H - filtersH - FOOTER_H - PADDING * 2;
  }
  function getGridX(): number { return PADDING; }
  function getGridY(): number { return HEADER_H + TABS_H + filtersH + PADDING; }

  // ── Build backdrop ──
  function buildBackdrop(): void {
    backdrop.clear();
    backdrop.rect(0, 0, app.screen.width, app.screen.height);
    backdrop.fill({ color: C_BG, alpha: 0.85 });
  }

  // ── Build header ──
  const searchLabel = new Text({ text: "Search:", style: { fill: C_TEXT_DIM, fontSize: 13, fontFamily: FONT } });
  const searchInput = new Text({ text: "", style: { fill: C_TEXT, fontSize: 14, fontFamily: FONT } });
  const closeBtn = new Text({ text: closeLabel, style: { fill: C_ACCENT, fontSize: 14, fontFamily: FONT } });

  function buildHeader(): void {
    headerBar.removeChildren();
    const bg = new Graphics();
    bg.rect(0, 0, app.screen.width, HEADER_H);
    bg.fill({ color: C_PANEL, alpha: 0.95 });
    bg.stroke({ color: C_PANEL_BORDER, width: 1 });
    headerBar.addChild(bg);

    const titleText = new Text({ text: title, style: { fill: C_ACCENT, fontSize: 18, fontFamily: FONT, fontWeight: "bold" } });
    titleText.x = PADDING; titleText.y = 10;
    headerBar.addChild(titleText);

    searchLabel.x = 200; searchLabel.y = 14;
    headerBar.addChild(searchLabel);
    const searchBox = new Graphics();
    searchBox.rect(260, 10, 300, 24);
    searchBox.fill({ color: 0x0a0a18, alpha: 0.9 });
    searchBox.stroke({ color: searchFocused ? 0xffffff : C_ACCENT, width: searchFocused ? 2 : 1 });
    // Click the field to enter search text (WASD included); Esc/click a card
    // returns focus to grid navigation.
    searchBox.eventMode = "static";
    searchBox.cursor = "text";
    searchBox.onclick = () => setSearchFocused(true);
    headerBar.addChild(searchBox);
    searchInput.x = 266; searchInput.y = 14;
    headerBar.addChild(searchInput);

    closeBtn.x = app.screen.width - closeBtn.width - PADDING;
    closeBtn.y = 14;
    closeBtn.eventMode = "static";
    closeBtn.cursor = "pointer";
    closeBtn.onclick = () => handlers.onClose?.();
    headerBar.addChild(closeBtn);
  }

  // ── Build tabs ──
  function buildTabs(): void {
    tabsBar.removeChildren();
    const bg = new Graphics();
    bg.rect(0, HEADER_H, app.screen.width, TABS_H);
    bg.fill({ color: C_PANEL, alpha: 0.8 });
    tabsBar.addChild(bg);

    let x = PADDING;
    const y = HEADER_H + 8;
    for (const p of packs) {
      const isActive = activePack === p.id;
      const btn = new Text({
        text: isActive ? `[${p.label}]` : p.label,
        style: { fill: isActive ? C_ACCENT : C_TEXT, fontSize: 13, fontFamily: FONT },
      });
      btn.x = x; btn.y = y;
      btn.eventMode = "static";
      btn.cursor = "pointer";
      btn.onclick = () => { activePack = p.id; scrollY = 0; rebuildGrid(); buildTabs(); buildFilters(); };
      tabsBar.addChild(btn);
      x += btn.width + 16;
    }
  }

  // ── Build filters ──
  function buildFilters(): void {
    filtersBar.removeChildren();
    if (!hasFilters) return;
    const bg = new Graphics();
    bg.rect(0, HEADER_H + TABS_H, app.screen.width, FILTERS_H);
    bg.fill({ color: C_PANEL, alpha: 0.6 });
    filtersBar.addChild(bg);

    let x = PADDING;
    const y = HEADER_H + TABS_H + 8;
    for (const c of config.categories ?? []) {
      const isActive = categoryFilter === c.id;
      const btn = new Text({
        text: isActive ? `[${c.label}]` : c.label,
        style: { fill: isActive ? C_ACCENT : C_TEXT_DIM, fontSize: 12, fontFamily: FONT },
      });
      btn.x = x; btn.y = y;
      btn.eventMode = "static";
      btn.cursor = "pointer";
      btn.onclick = () => { categoryFilter = c.id; scrollY = 0; rebuildGrid(); buildFilters(); };
      filtersBar.addChild(btn);
      x += btn.width + 12;
    }

    // Sort toggle (only with >1 sort mode)
    if (sortModes.length > 1) {
      const sortLabel = new Text({ text: "Sort:", style: { fill: C_TEXT_DIM, fontSize: 12, fontFamily: FONT } });
      sortLabel.x = x + 20; sortLabel.y = y;
      filtersBar.addChild(sortLabel);
      const activeMode = sortModes.find((m) => m.id === sortBy) ?? sortModes[0];
      const sortBtn = new Text({
        text: activeMode.label,
        style: { fill: C_ACCENT, fontSize: 12, fontFamily: FONT },
      });
      sortBtn.x = x + 56; sortBtn.y = y;
      sortBtn.eventMode = "static";
      sortBtn.cursor = "pointer";
      sortBtn.onclick = () => {
        const idx = sortModes.findIndex((m) => m.id === sortBy);
        sortBy = sortModes[(idx + 1) % sortModes.length].id;
        rebuildGrid(); buildFilters();
      };
      filtersBar.addChild(sortBtn);
    }
  }

  // ── Build grid (cards) ──
  function rebuildGrid(): void {
    // Clear old cards
    for (const c of cards) {
      c.container.destroy({ children: true });
      c.texture.destroy(true);
    }
    cards = [];
    gridArea.removeChildren();

    const allItems = getFilteredItems();
    // Limit cards to avoid the lag of creating thousands of containers at once.
    const items = allItems.slice(0, maxCards);
    const gridW = getGridWidth();
    const cols = Math.max(1, Math.floor((gridW + CARD_GAP) / (CARD_W + CARD_GAP)));
    const colW = CARD_W + CARD_GAP;

    // Grid background + drag-to-scroll
    const gridBg = new Graphics();
    const gy = getGridY();
    const gh = getGridHeight();
    gridBg.rect(0, gy, gridW, gh);
    gridBg.fill({ color: 0x0a0a14, alpha: 0.5 });
    gridBg.stroke({ color: 0x333355, width: 1 });
    gridArea.addChild(gridBg);

    // Mask for clipping — skipped on native: the wgpu render target lacks a
    // stencil path for pixi masks, and layoutCards() already culls off-screen
    // cards via container.visible (partial cards at scroll edges overdraw —
    // acceptable vs a white mask rect covering the grid).
    if (!isNativeRuntime()) {
      const mask = new Graphics();
      mask.rect(0, gy, gridW, gh);
      mask.fill({ color: 0xffffff });
      gridArea.addChild(mask);
      gridArea.mask = mask;
    }

    // Drag-to-scroll on the grid background
    gridBg.eventMode = "static";
    gridBg.cursor = "grab";
    gridBg.on("pointerdown", (e) => {
      dragScrolling = true;
      dragStartY = e.global.y;
      dragStartScroll = scrollY;
      dragMoved = false;
      gridBg.cursor = "grabbing";
    });
    gridBg.on("pointermove", (e) => {
      if (!dragScrolling) return;
      const dy = e.global.y - dragStartY;
      if (Math.abs(dy) > 5) dragMoved = true;
      scrollY = Math.max(0, Math.min(maxScrollY, dragStartScroll - dy));
      layoutCards();
    });
    gridBg.on("pointerup", () => { dragScrolling = false; gridBg.cursor = "grab"; });
    gridBg.on("pointerupoutside", () => { dragScrolling = false; gridBg.cursor = "grab"; });

    // Create cards
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const card = createCard(item);
      const row = Math.floor(i / cols);
      const col = i % cols;
      card.container.x = getGridX() + col * colW + CARD_GAP;
      card.container.y = gy + row * (CARD_H + CARD_GAP) + CARD_GAP - scrollY;
      cards.push(card);
      gridArea.addChild(card.container);
    }

    // Compute max scroll
    const totalRows = Math.ceil(items.length / cols);
    const totalH = totalRows * (CARD_H + CARD_GAP) + CARD_GAP;
    maxScrollY = Math.max(0, totalH - gh);

    // Update footer count
    buildFooter();
  }

  // ── Create a single card ──
  function createCard(item: T): CardEntry<T> {
    const container = new Container();
    container.eventMode = "static";
    container.cursor = "pointer";

    // Card background
    const bg = new Graphics();
    bg.roundRect(0, 0, CARD_W, CARD_H, 6);
    bg.fill({ color: item.id === selectedContentId ? C_CARD_SELECTED : C_CARD });
    bg.stroke({ color: item.id === selectedContentId ? C_ACCENT : 0x333355, width: item.id === selectedContentId ? 2 : 1 });
    container.addChild(bg);

    // Thumbnail canvas (2D) + PIXI texture
    const thumbCanvas = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE);
    const thumbCtx = thumbCanvas.getContext("2d")!;
    // Fill with a placeholder color
    thumbCtx.fillStyle = "#1a1a2e";
    thumbCtx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);

    // Use Texture.from() to create a canvas-backed texture. In PIXI v8 this
    // auto-detects the CanvasSource extension for OffscreenCanvas resources.
    let texture: Texture;
    try {
      texture = Texture.from(thumbCanvas);
    } catch {
      // Fallback: create a blank texture
      texture = Texture.EMPTY;
    }
    const sprite = new Sprite(texture);
    sprite.x = (CARD_W - THUMB_SIZE) / 2;
    sprite.y = 8;
    container.addChild(sprite);

    // Name text
    const nameText = new Text({
      text: item.name.length > 18 ? item.name.substring(0, 17) + "…" : item.name,
      style: { fill: C_TEXT, fontSize: 11, fontFamily: FONT, align: "center" },
    });
    nameText.anchor.set(0.5, 0);
    nameText.x = CARD_W / 2;
    nameText.y = THUMB_SIZE + 14;
    container.addChild(nameText);

    // Secondary label (pack label or game-provided sub)
    const packText = new Text({
      text: item.sub ?? item.packLabel,
      style: { fill: C_TEXT_DIM, fontSize: 9, fontFamily: FONT },
    });
    packText.anchor.set(0.5, 0);
    packText.x = CARD_W / 2;
    packText.y = THUMB_SIZE + 30;
    container.addChild(packText);

    // Badge (top-right corner)
    const countText = new Text({
      text: badgeText(item, badgeCounts[item.id] ?? 0) ?? "",
      style: { fill: C_COUNT, fontSize: 12, fontFamily: FONT, fontWeight: "bold" },
    });
    countText.x = CARD_W - 30;
    countText.y = 4;
    container.addChild(countText);

    // Selection + double-click activate
    let lastClickTime = 0;
    container.onclick = () => {
      if (dragMoved) return;
      setSearchFocused(false);
      const now = performance.now();
      selectCard(item.id);
      if (now - lastClickTime < 350) {
        // Double-click → activate
        handlers.onActivate?.(item);
      }
      lastClickTime = now;
    };

    return { item, container, thumbCanvas, thumbCtx, texture, sprite, nameText, countText, angle: 0, modelLoaded: false, thumbRendered: false };
  }

  // ── Layout cards (reposition based on scroll) ──
  function layoutCards(): void {
    const gridW = getGridWidth();
    const cols = Math.max(1, Math.floor((gridW + CARD_GAP) / (CARD_W + CARD_GAP)));
    const colW = CARD_W + CARD_GAP;
    const gy = getGridY();
    const gh = getGridHeight();

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const row = Math.floor(i / cols);
      const col = i % cols;
      const y = gy + row * (CARD_H + CARD_GAP) + CARD_GAP - scrollY;
      card.container.x = getGridX() + col * colW + CARD_GAP;
      card.container.y = y;
      // Only show cards within the visible area (+ buffer)
      card.container.visible = y > gy - CARD_H && y < gy + gh;
    }
  }

  // ── Select a card ──
  function selectCard(contentId: string): void {
    selectedContentId = contentId;
    // Update card backgrounds
    for (const c of cards) {
      const bg = c.container.children[0] as Graphics;
      const isSelected = c.item.id === contentId;
      bg.clear();
      bg.roundRect(0, 0, CARD_W, CARD_H, 6);
      bg.fill({ color: isSelected ? C_CARD_SELECTED : C_CARD });
      bg.stroke({ color: isSelected ? C_ACCENT : 0x333355, width: isSelected ? 2 : 1 });
    }
    const item = cards.find((c) => c.item.id === contentId)?.item
      ?? contentItems.find((i) => i.id === contentId) ?? null;
    handlers.onSelect?.(item);
    buildSettingsPanel();
  }

  // ── Build side panel ──
  function buildSettingsPanel(): void {
    settingsPanel.removeChildren();
    if (!hasSidePanel) return;
    const px = app.screen.width - sidePanelW - PADDING;
    const py = getGridY();
    const ph = getGridHeight();

    const bg = new Graphics();
    bg.roundRect(px, py, sidePanelW, ph, 6);
    bg.fill({ color: C_PANEL, alpha: 0.95 });
    bg.stroke({ color: C_PANEL_BORDER, width: 1 });
    settingsPanel.addChild(bg);

    let y = py + 12;
    const x = px + 12;
    const labelW = sidePanelW - 24;

    // Selected name
    const selItem = cards.find((c) => c.item.id === selectedContentId)?.item
      ?? contentItems.find((i) => i.id === selectedContentId) ?? null;
    const selLabel = new Text({
      text: selItem ? selItem.name : "No selection",
      style: { fill: C_ACCENT, fontSize: 14, fontFamily: FONT, fontWeight: "bold" },
    });
    selLabel.x = x; selLabel.y = y;
    settingsPanel.addChild(selLabel);
    y += 24;

    if (!selItem) {
      const hint = new Text({
        text: emptyHint,
        style: { fill: C_TEXT_DIM, fontSize: 11, fontFamily: FONT },
      });
      hint.x = x; hint.y = y;
      settingsPanel.addChild(hint);
      return;
    }

    const ui = createSidePanelUi(settingsPanel, x, y, labelW);
    config.sidePanel!({
      panel: settingsPanel,
      item: selItem,
      badgeCount: badgeCounts[selItem.id] ?? 0,
      width: labelW,
      ui,
      rebuild: buildSettingsPanel,
    });
  }

  // ── Build footer ──
  function buildFooter(): void {
    footerBar.removeChildren();
    const fy = app.screen.height - FOOTER_H;
    const bg = new Graphics();
    bg.rect(0, fy, app.screen.width, FOOTER_H);
    bg.fill({ color: C_PANEL, alpha: 0.9 });
    bg.stroke({ color: C_PANEL_BORDER, width: 1 });
    footerBar.addChild(bg);

    let infoX = PADDING;
    if (config.footerButton) {
      const btn = new Text({
        text: config.footerButton.label,
        style: { fill: config.footerButton.color ?? 0xff6666, fontSize: 13, fontFamily: FONT },
      });
      btn.x = PADDING; btn.y = fy + 8;
      btn.eventMode = "static"; btn.cursor = "pointer";
      btn.onclick = () => config.footerButton!.onClick();
      footerBar.addChild(btn);
      infoX = PADDING + btn.width + 32;
    }

    const allItems = getFilteredItems();
    const info = new Text({
      text: `Showing ${Math.min(allItems.length, maxCards)} of ${allItems.length} items${allItems.length > maxCards ? " — use search/filters to narrow" : ""}`,
      style: { fill: C_TEXT_DIM, fontSize: 12, fontFamily: FONT },
    });
    info.x = infoX; info.y = fy + 8;
    footerBar.addChild(info);

    const badgeTotal = Object.values(badgeCounts).reduce((a, b) => a + b, 0);
    const rightText = config.footerRight
      ? config.footerRight(badgeTotal)
      : `Total: ${badgeTotal}`;
    const rightLabel = new Text({ text: rightText, style: { fill: C_ACCENT, fontSize: 12, fontFamily: FONT } });
    rightLabel.x = app.screen.width - rightLabel.width - PADDING;
    rightLabel.y = fy + 8;
    footerBar.addChild(rightLabel);
  }

  // ── Thumbnail rendering ──
  function initThumbnails(): void {
    if (thumbRenderer) return;
    try {
      const factory = config.thumbnailBackend
        ?? (ctx.sceneConfig as { createThumbnailRenderer?: (size: number) => ThumbnailBackend } | undefined)
          ?.createThumbnailRenderer;
      thumbRenderer = factory ? factory(THUMB_SIZE) : new ThumbnailRenderer(THUMB_SIZE);
    } catch (err) {
      console.warn("[AssetBrowser] ThumbnailRenderer init failed:", err);
    }
  }

  function updateThumbnails(): void {
    const tr = thumbRenderer;
    if (!showBrowser || !tr) return;
    // Load models for visible cards that haven't been loaded yet (limit concurrency).
    let loadCount = 0;
    const MAX_CONCURRENT_LOADS = 6;
    const pendingLoads = cards.filter((c) => c.container.visible && !c.modelLoaded);
    for (const card of pendingLoads) {
      if (loadCount >= MAX_CONCURRENT_LOADS) break;
      card.modelLoaded = true;
      const item = card.item;
      const kind = thumbKind(item);
      if (kind === "model" && item.modelUri) {
        tr.loadModelThumb(item.modelUri, item.id);
      } else if (kind === "sphere") {
        tr.loadBuiltinSphere(item.id);
      } else if (kind === "cube") {
        tr.loadBuiltinCube(item.id);
      }
      loadCount++;
    }

    // Render thumbnails for every visible card with a loaded model.
    // renderThumb draws into the shared canvas; drawImage composites it
    // into the card's 2D canvas — a GPU-side copy with no CPU readback, so
    // every visible card can spin every frame (no render budget needed).
    const visibleCards = cards.filter((c) => c.container.visible);
    for (const card of visibleCards) {
      card.angle += 0.02; // uniform turntable speed for all cards
      if (!tr.has(card.item.id)) continue;
      try {
        if (!tr.renderThumb(card.item.id, card.angle)) continue;
        card.thumbCtx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
        card.thumbCtx.drawImage(tr.canvasElement, 0, 0);
        // Bypass update() — emit "update" directly to trigger GPU re-upload.
        const src = card.texture.source as any;
        src.emit("update", src);
        card.thumbRendered = true;
      } catch (e) {
        if (!(card as any)._renderErr) {
          (card as any)._renderErr = true;
          console.error(`[AssetBrowser] Render error for "${card.item.id}":`, e);
        }
      }
    }
  }

  function setSearchFocused(f: boolean): void {
    if (f === searchFocused) return;
    searchFocused = f;
    buildHeader();
    handlers.onSearchFocus?.(f);
  }

  // ── Keyboard navigation ──
  function handleKeydown(key: string, code: string): void {
    if (!showBrowser) return;

    if (searchFocused) {
      // Text entry — every printable key goes to the query (WASD included).
      if (code === "Backspace") {
        if (searchQuery.length > 0) {
          searchQuery = searchQuery.slice(0, -1);
          searchInput.text = searchQuery;
          scrollY = 0;
          rebuildGrid();
        }
      } else if (code === "Escape") {
        if (searchQuery.length > 0) {
          searchQuery = "";
          searchInput.text = "";
          scrollY = 0;
          rebuildGrid();
        }
        setSearchFocused(false);
      } else if (code === "Enter") {
        activateSelection();
      } else if (key.length === 1 && key >= " " && key <= "~") {
        searchQuery += key;
        searchInput.text = searchQuery;
        scrollY = 0;
        rebuildGrid();
      }
      return;
    }

    if (code === "Backspace") {
      if (searchQuery.length > 0) {
        searchQuery = searchQuery.slice(0, -1);
        searchInput.text = searchQuery;
        scrollY = 0;
        rebuildGrid();
      }
      return;
    }
    if (code === "Escape") {
      if (searchQuery.length > 0) {
        searchQuery = "";
        searchInput.text = "";
        scrollY = 0;
        rebuildGrid();
      } else {
        handlers.onClose?.();
      }
      return;
    }
    if (code === "Tab") {
      // Cycle to next pack
      const idx = packs.findIndex((p) => p.id === activePack);
      activePack = packs[(idx + 1) % packs.length].id;
      scrollY = 0;
      rebuildGrid();
      buildTabs();
      return;
    }
    if (code === "Enter" || code === "Space") {
      activateSelection();
      return;
    }

    // Arrow / WASD navigation
    if (code === "ArrowUp" || code === "KeyW") { moveSelection(0, -1); return; }
    if (code === "ArrowDown" || code === "KeyS") { moveSelection(0, 1); return; }
    if (code === "ArrowLeft" || code === "KeyA") { moveSelection(-1, 0); return; }
    if (code === "ArrowRight" || code === "KeyD") { moveSelection(1, 0); return; }

    // Printable char → focus the search field and start the query
    if (key.length === 1 && key >= " " && key <= "~") {
      setSearchFocused(true);
      searchQuery += key;
      searchInput.text = searchQuery;
      scrollY = 0;
      rebuildGrid();
    }
  }

  function activateSelection(): void {
    const item = cards.find((c) => c.item.id === selectedContentId)?.item
      ?? contentItems.find((i) => i.id === selectedContentId);
    if (item) handlers.onActivate?.(item);
  }

  function moveSelection(dx: number, dy: number): void {
    if (cards.length === 0) return;
    const gridW = getGridWidth();
    const cols = Math.max(1, Math.floor((gridW + CARD_GAP) / (CARD_W + CARD_GAP)));
    let idx = cards.findIndex((c) => c.item.id === selectedContentId);
    if (idx < 0) idx = 0;
    let row = Math.floor(idx / cols);
    let col = idx % cols;
    col = Math.max(0, Math.min(cols - 1, col + dx));
    row = Math.max(0, row + dy);
    let newIdx = row * cols + col;
    if (newIdx >= cards.length) newIdx = cards.length - 1;
    if (newIdx < 0) return;
    const newId = cards[newIdx].item.id;
    selectCard(newId);
    // Auto-scroll to keep the selected card visible
    const gy = getGridY();
    const gh = getGridHeight();
    const cardY = gy + row * (CARD_H + CARD_GAP) + CARD_GAP - scrollY;
    if (cardY < gy) scrollY -= (gy - cardY);
    else if (cardY + CARD_H > gy + gh) scrollY += (cardY + CARD_H - gy - gh);
    scrollY = Math.max(0, Math.min(maxScrollY, scrollY));
    layoutCards();
  }

  // ── Show/hide browser ──
  function setShowBrowser(show: boolean): void {
    if (show === showBrowser) return;
    showBrowser = show;
    browserRoot.visible = show;
    backdrop.visible = show;
    ctx.setInteractive(show);
    if (!show) setSearchFocused(false);
    if (show) {
      initThumbnails();
      // Items may already have been pushed via setItems()/events.
    }
  }

  function applyItems(items: T[]): void {
    contentItems = items;
    derivePacks();
    scrollY = 0;
    rebuildGrid();
    buildTabs();
    buildFilters();
    buildSettingsPanel();
  }

  function applyBadges(counts: Record<string, number>): void {
    badgeCounts = counts;
    // Update badge text on live cards
    for (const card of cards) {
      card.countText.text = badgeText(card.item, badgeCounts[card.item.id] ?? 0) ?? "";
    }
    buildFooter();
    buildSettingsPanel();
  }

  // ── Initial build ──
  buildBackdrop();
  buildHeader();
  buildTabs();
  buildFilters();
  rebuildGrid();
  buildSettingsPanel();
  buildFooter();

  const scene: AssetBrowserScene<T> = {
    root,
    update(data: PixiUiUpdateData) {
      const stats = data.stats as Record<string, number> | undefined;
      const events = data.events as any[] | undefined;

      // Read visibility from stats
      const newShow = (stats?.[visibleStat] ?? 0) !== 0;
      if (newShow !== showBrowser) setShowBrowser(newShow);

      // Process events
      if (events) {
        for (const evt of events) {
          if (evt.kind === "items" || evt.kind === "contentList") {
            applyItems(evt.items as T[]);
          } else if (evt.kind === "badges" || evt.kind === "spawnCounts") {
            applyBadges(evt.counts as Record<string, number>);
          } else if (evt.kind === "keydown") {
            handleKeydown(evt.key, evt.code);
          }
        }
      }

      // Update caret blink (only while the search field is focused)
      if (showBrowser) {
        caretBlink += data.dt;
        const showCaret = searchFocused && Math.floor(caretBlink / 0.5) % 2 === 0;
        searchInput.text = searchQuery + (showCaret ? "_" : " ");
      }

      // Render thumbnails
      updateThumbnails();
    },
    resize(width: number, height: number) {
      buildBackdrop();
      buildHeader();
      buildTabs();
      buildFilters();
      rebuildGrid();
      buildSettingsPanel();
      buildFooter();
    },
    setItems: applyItems,
    setBadges: applyBadges,
    setVisible: setShowBrowser,
    isVisible: () => showBrowser,
    getSelected: () => cards.find((c) => c.item.id === selectedContentId)?.item
      ?? contentItems.find((i) => i.id === selectedContentId) ?? null,
    dispose() {
      if (thumbRenderer) { thumbRenderer.dispose(); thumbRenderer = null; }
      for (const c of cards) { c.texture.destroy(true); }
      root.destroy({ children: true });
    },
  };
  return scene;
}
