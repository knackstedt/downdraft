// ============================================================================
// Andrew's Sandbox pixi-scene — GMod-style fullscreen asset browser.
// Runs in the pixi-ui Web Worker. Renders the browser UI with PixiJS and
// 3D model thumbnails via a dedicated ThumbnailRenderer (WebGL2 OffscreenCanvas).
// ============================================================================

import type { PixiUiScene, PixiUiSceneContext, PixiUiUpdateData } from "@downdraft/library-pixi-ui";
import { Container, Graphics, Sprite, Text, Texture, type Application } from "pixi.js";
import type { ContentListItem, SandboxAction, SpawnSettings } from "./bridge-protocol";
import { ThumbnailRenderer } from "./thumbnail-renderer";

// ── Colors ──
const C_BG = 0x0a0a14;
const C_PANEL = 0x141428;
const C_PANEL_BORDER = 0x4e9af1;
const C_ACCENT = 0x4e9af1;
const C_TEXT = 0xe0e0e0;
const C_TEXT_DIM = 0x888888;
const C_CARD = 0x1a1a2e;
const C_CARD_SELECTED = 0x2a3a5e;
const C_CARD_HOVER = 0x222240;
const C_COUNT = 0x4e9af1;
const C_BTN = 0x2a2a4e;
const C_BTN_HOVER = 0x3a3a6e;
const C_BTN_ACTIVE = 0x4e9af1;
const C_STUB = 0xff9944;

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

// ── Textures per card (2D OffscreenCanvas → PIXI Texture) ──
interface CardEntry {
  item: ContentListItem;
  container: Container;
  thumbCanvas: OffscreenCanvas;
  thumbCtx: OffscreenCanvasRenderingContext2D;
  texture: Texture;
  sprite: Sprite;
  nameText: Text;
  countText: Text;
  angle: number;
  modelLoaded: boolean;
}

export default async function createSandboxScene(ctx: PixiUiSceneContext): Promise<PixiUiScene> {
  const app: Application = ctx.app;
  const postAction = (a: SandboxAction) => ctx.postAction(a as any);

  const root = new Container();
  app.stage.addChild(root);

  // ── State ──
  let showBrowser = false;
  let contentItems: ContentListItem[] = [];
  let spawnCounts: Record<string, number> = {};
  let activePack = "all";
  let searchQuery = "";
  let categoryFilter = "all";
  let sortBy: "name" | "count" = "name";
  let selectedContentId: string | null = null;
  let scrollY = 0;
  let maxScrollY = 0;
  let cards: CardEntry[] = [];
  let thumbRenderer: ThumbnailRenderer | null = null;
  // Temp canvas for pixel transfer (putImageData → drawImage)
  const tempThumbCanvas = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE);
  const tempThumbCtx = tempThumbCanvas.getContext("2d")!;
  let _loopDebug = false;
  let _thumbFrame = 0;
  let thumbTexture: Texture | null = null;
  let caretBlink = 0;
  let dragScrolling = false;
  let dragStartY = 0;
  let dragStartScroll = 0;
  let dragMoved = false;

  // Persistent spawn settings (survive across card selections)
  const settings: SpawnSettings = {
    mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0,
    scale: 1.0, shape: "box",
    strength: 100, texture: "Default", shader: "Standard",
  };

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
  function getFilteredItems(): ContentListItem[] {
    let items = contentItems;
    if (activePack !== "all") items = items.filter((i) => i.pack === activePack);
    if (categoryFilter !== "all") items = items.filter((i) => i.category === categoryFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter((i) => i.name.toLowerCase().includes(q));
    }
    const sorted = [...items];
    if (sortBy === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else sorted.sort((a, b) => (spawnCounts[b.id] ?? 0) - (spawnCounts[a.id] ?? 0));
    return sorted;
  }

  // ── Layout dimensions ──
  function getGridWidth(): number {
    return app.screen.width - SETTINGS_W - PADDING * 3;
  }
  function getGridHeight(): number {
    return app.screen.height - HEADER_H - TABS_H - FILTERS_H - FOOTER_H - PADDING * 2;
  }
  function getGridX(): number { return PADDING; }
  function getGridY(): number { return HEADER_H + TABS_H + FILTERS_H + PADDING; }

  // ── Build backdrop ──
  function buildBackdrop(): void {
    backdrop.clear();
    backdrop.rect(0, 0, app.screen.width, app.screen.height);
    backdrop.fill({ color: C_BG, alpha: 0.85 });
  }

  // ── Build header ──
  const searchLabel = new Text({ text: "Search:", style: { fill: C_TEXT_DIM, fontSize: 13, fontFamily: "Segoe UI, Arial, sans-serif" } });
  const searchInput = new Text({ text: "", style: { fill: C_TEXT, fontSize: 14, fontFamily: "Segoe UI, Arial, sans-serif" } });
  const closeBtn = new Text({ text: "[X] Close (B)", style: { fill: C_ACCENT, fontSize: 14, fontFamily: "Segoe UI, Arial, sans-serif" } });

  function buildHeader(): void {
    headerBar.removeChildren();
    const bg = new Graphics();
    bg.rect(0, 0, app.screen.width, HEADER_H);
    bg.fill({ color: C_PANEL, alpha: 0.95 });
    bg.stroke({ color: C_PANEL_BORDER, width: 1 });
    headerBar.addChild(bg);

    const title = new Text({ text: "Asset Browser", style: { fill: C_ACCENT, fontSize: 18, fontFamily: "Segoe UI, Arial, sans-serif", fontWeight: "bold" } });
    title.x = PADDING; title.y = 10;
    headerBar.addChild(title);

    searchLabel.x = 200; searchLabel.y = 14;
    headerBar.addChild(searchLabel);
    const searchBox = new Graphics();
    searchBox.rect(260, 10, 300, 24);
    searchBox.fill({ color: 0x0a0a18, alpha: 0.9 });
    searchBox.stroke({ color: C_ACCENT, width: 1 });
    headerBar.addChild(searchBox);
    searchInput.x = 266; searchInput.y = 14;
    headerBar.addChild(searchInput);

    closeBtn.x = app.screen.width - 160; closeBtn.y = 14;
    closeBtn.eventMode = "static";
    closeBtn.cursor = "pointer";
    closeBtn.onclick = () => postAction({ kind: "closeBrowser" });
    headerBar.addChild(closeBtn);
  }

  // ── Build tabs ──
  let tabBtns: Array<{ btn: Text; packId: string }> = [];
  function buildTabs(): void {
    tabsBar.removeChildren();
    tabBtns = [];
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
        style: { fill: isActive ? C_ACCENT : C_TEXT, fontSize: 13, fontFamily: "Segoe UI, Arial, sans-serif" },
      });
      btn.x = x; btn.y = y;
      btn.eventMode = "static";
      btn.cursor = "pointer";
      btn.onclick = () => { activePack = p.id; scrollY = 0; rebuildGrid(); buildTabs(); buildFilters(); };
      tabsBar.addChild(btn);
      tabBtns.push({ btn, packId: p.id });
      x += btn.width + 16;
    }
  }

  // ── Build filters ──
  function buildFilters(): void {
    filtersBar.removeChildren();
    const bg = new Graphics();
    bg.rect(0, HEADER_H + TABS_H, app.screen.width, FILTERS_H);
    bg.fill({ color: C_PANEL, alpha: 0.6 });
    filtersBar.addChild(bg);

    const cats: Array<{ id: string; label: string }> = [
      { id: "all", label: "All" },
      { id: "prop", label: "Props" },
      { id: "texture", label: "Textures" },
      { id: "data", label: "Data" },
      { id: "builtin", label: "Builtin" },
    ];
    let x = PADDING;
    const y = HEADER_H + TABS_H + 8;
    for (const c of cats) {
      const isActive = categoryFilter === c.id;
      const btn = new Text({
        text: isActive ? `[${c.label}]` : c.label,
        style: { fill: isActive ? C_ACCENT : C_TEXT_DIM, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" },
      });
      btn.x = x; btn.y = y;
      btn.eventMode = "static";
      btn.cursor = "pointer";
      btn.onclick = () => { categoryFilter = c.id; scrollY = 0; rebuildGrid(); buildFilters(); };
      filtersBar.addChild(btn);
      x += btn.width + 12;
    }

    // Sort toggle
    const sortLabel = new Text({ text: "Sort:", style: { fill: C_TEXT_DIM, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" } });
    sortLabel.x = x + 20; sortLabel.y = y;
    filtersBar.addChild(sortLabel);
    const sortBtn = new Text({
      text: sortBy === "name" ? "Name" : "Count",
      style: { fill: C_ACCENT, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" },
    });
    sortBtn.x = x + 56; sortBtn.y = y;
    sortBtn.eventMode = "static";
    sortBtn.cursor = "pointer";
    sortBtn.onclick = () => { sortBy = sortBy === "name" ? "count" : "name"; rebuildGrid(); buildFilters(); };
    filtersBar.addChild(sortBtn);
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
    // Limit to 200 cards to avoid the lag of creating 1700+ PIXI containers at once.
    const items = allItems.slice(0, 200);
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

    // Mask for clipping
    const mask = new Graphics();
    mask.rect(0, gy, gridW, gh);
    mask.fill({ color: 0xffffff });
    gridArea.addChild(mask);
    gridArea.mask = mask;

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
  function createCard(item: ContentListItem): CardEntry {
    const container = new Container();
    container.eventMode = "static";
    container.cursor = "pointer";

    // Card background
    const bg = new Graphics();
    bg.roundRect(0, 0, CARD_W, CARD_H, 6);
    bg.fill({ color: C_CARD });
    bg.stroke({ color: 0x333355, width: 1 });
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
      style: { fill: C_TEXT, fontSize: 11, fontFamily: "Segoe UI, Arial, sans-serif", align: "center" },
    });
    nameText.anchor.set(0.5, 0);
    nameText.x = CARD_W / 2;
    nameText.y = THUMB_SIZE + 14;
    container.addChild(nameText);

    // Pack label (small)
    const packText = new Text({
      text: item.packLabel,
      style: { fill: C_TEXT_DIM, fontSize: 9, fontFamily: "Segoe UI, Arial, sans-serif" },
    });
    packText.anchor.set(0.5, 0);
    packText.x = CARD_W / 2;
    packText.y = THUMB_SIZE + 30;
    container.addChild(packText);

    // Count badge
    const countText = new Text({
      text: "×0",
      style: { fill: C_COUNT, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif", fontWeight: "bold" },
    });
    countText.x = CARD_W - 30;
    countText.y = 4;
    container.addChild(countText);

    // Selection + double-click spawn
    let lastClickTime = 0;
    container.onclick = () => {
      if (dragMoved) return;
      const now = performance.now();
      selectCard(item.id);
      if (now - lastClickTime < 350) {
        // Double-click → spawn
        doSpawn(1);
      }
      lastClickTime = now;
    };

    return { item, container, thumbCanvas, thumbCtx, texture, sprite, nameText, countText, angle: 0, modelLoaded: false };
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
    // Update shape from the selected item's default
    const item = cards.find((c) => c.item.id === contentId)?.item;
    if (item?.shape) settings.shape = item.shape;
    buildSettingsPanel();
  }

  // ── Build settings panel ──
  function buildSettingsPanel(): void {
    settingsPanel.removeChildren();
    const px = app.screen.width - SETTINGS_W - PADDING;
    const py = getGridY();
    const ph = getGridHeight();

    const bg = new Graphics();
    bg.roundRect(px, py, SETTINGS_W, ph, 6);
    bg.fill({ color: C_PANEL, alpha: 0.95 });
    bg.stroke({ color: C_PANEL_BORDER, width: 1 });
    settingsPanel.addChild(bg);

    let y = py + 12;
    const x = px + 12;
    const labelW = SETTINGS_W - 24;

    // Selected name
    const selItem = cards.find((c) => c.item.id === selectedContentId)?.item;
    const selLabel = new Text({
      text: selItem ? selItem.name : "No selection",
      style: { fill: C_ACCENT, fontSize: 14, fontFamily: "Segoe UI, Arial, sans-serif", fontWeight: "bold" },
    });
    selLabel.x = x; selLabel.y = y;
    settingsPanel.addChild(selLabel);
    y += 24;

    if (!selItem) {
      const hint = new Text({
        text: "Click a card to select.\nDouble-click or press Enter to spawn.\n\nKeyboard:\n WASD/Arrows: navigate\n Tab: next pack\n Enter: spawn\n Backspace: edit search\n Esc: clear/close",
        style: { fill: C_TEXT_DIM, fontSize: 11, fontFamily: "Segoe UI, Arial, sans-serif" },
      });
      hint.x = x; hint.y = y;
      settingsPanel.addChild(hint);
      return;
    }

    // Sliders
    y = addSlider("Weight", settings.mass, 0.1, 100, 0.1, y, x, labelW, (v) => { settings.mass = v; });
    y = addSlider("Bounce", settings.restitution, 0, 1, 0.05, y, x, labelW, (v) => { settings.restitution = v; });
    y = addSlider("Strength (stub)", settings.strength, 1, 1000, 1, y, x, labelW, (v) => { settings.strength = v; }, true);
    y = addSlider("Scale", settings.scale, 0.1, 10, 0.1, y, x, labelW, (v) => { settings.scale = v; });
    y += 4;

    // Shape toggle
    const shapeLabel = new Text({ text: "Shape:", style: { fill: C_TEXT_DIM, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" } });
    shapeLabel.x = x; shapeLabel.y = y;
    settingsPanel.addChild(shapeLabel);
    y += 18;
    const boxBtn = new Text({
      text: settings.shape === "box" ? "[Box]" : "Box",
      style: { fill: settings.shape === "box" ? C_ACCENT : C_TEXT, fontSize: 13, fontFamily: "Segoe UI, Arial, sans-serif" },
    });
    boxBtn.x = x; boxBtn.y = y;
    boxBtn.eventMode = "static"; boxBtn.cursor = "pointer";
    boxBtn.onclick = () => { settings.shape = "box"; buildSettingsPanel(); };
    settingsPanel.addChild(boxBtn);
    const sphereBtn = new Text({
      text: settings.shape === "sphere" ? "[Sphere]" : "Sphere",
      style: { fill: settings.shape === "sphere" ? C_ACCENT : C_TEXT, fontSize: 13, fontFamily: "Segoe UI, Arial, sans-serif" },
    });
    sphereBtn.x = x + 60; sphereBtn.y = y;
    sphereBtn.eventMode = "static"; sphereBtn.cursor = "pointer";
    sphereBtn.onclick = () => { settings.shape = "sphere"; buildSettingsPanel(); };
    settingsPanel.addChild(sphereBtn);
    y += 24;

    // Texture dropdown (stub)
    y = addDropdown("Texture (stub)", settings.texture, ["Default", "Wireframe", "Custom"], y, x, labelW, (v) => { settings.texture = v; }, true);
    // Shader dropdown (stub)
    y = addDropdown("Shader (stub)", settings.shader, ["Standard", "Toon", "Hologram", "Outline"], y, x, labelW, (v) => { settings.shader = v; }, true);
    y += 8;

    // Spawn buttons
    const spawnBtn = new Text({ text: "[ Spawn ]", style: { fill: C_ACCENT, fontSize: 15, fontFamily: "Segoe UI, Arial, sans-serif", fontWeight: "bold" } });
    spawnBtn.x = x; spawnBtn.y = y;
    spawnBtn.eventMode = "static"; spawnBtn.cursor = "pointer";
    spawnBtn.onclick = () => doSpawn(1);
    settingsPanel.addChild(spawnBtn);

    const spawn10Btn = new Text({ text: "[ Spawn ×10 ]", style: { fill: C_ACCENT, fontSize: 15, fontFamily: "Segoe UI, Arial, sans-serif", fontWeight: "bold" } });
    spawn10Btn.x = x + 100; spawn10Btn.y = y;
    spawn10Btn.eventMode = "static"; spawn10Btn.cursor = "pointer";
    spawn10Btn.onclick = () => doSpawn(10);
    settingsPanel.addChild(spawn10Btn);
    y += 28;

    // Current count
    const cnt = (selectedContentId ? spawnCounts[selectedContentId] : 0) ?? 0;
    const countLabel = new Text({ text: `Spawned: ${cnt}`, style: { fill: C_TEXT_DIM, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" } });
    countLabel.x = x; countLabel.y = y;
    settingsPanel.addChild(countLabel);
  }

  // ── Slider helper ──
  function addSlider(label: string, value: number, min: number, max: number, step: number, y: number, x: number, w: number, onChange: (v: number) => void, isStub = false): number {
    const color = isStub ? C_STUB : C_TEXT;
    const lbl = new Text({ text: `${label}: ${value.toFixed(value < 10 ? 2 : 0)}`, style: { fill: color, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" } });
    lbl.x = x; lbl.y = y;
    settingsPanel.addChild(lbl);
    y += 16;

    const trackW = w - 20;
    const track = new Graphics();
    track.rect(x, y, trackW, 6);
    track.fill({ color: 0x333355 });
    track.stroke({ color: 0x555577, width: 1 });
    settingsPanel.addChild(track);

    const knobX = x + ((value - min) / (max - min)) * trackW;
    const knob = new Graphics();
    knob.circle(knobX, y + 3, 7);
    knob.fill({ color: isStub ? C_STUB : C_ACCENT });
    knob.eventMode = "static";
    knob.cursor = "pointer";
    let dragging = false;
    const updateKnob = (globalX: number) => {
      const t = Math.max(0, Math.min(1, (globalX - x) / trackW));
      let newVal = min + t * (max - min);
      newVal = Math.round(newVal / step) * step;
      newVal = Math.max(min, Math.min(max, newVal));
      lbl.text = `${label}: ${newVal.toFixed(newVal < 10 ? 2 : 0)}`;
      knob.x = ((newVal - min) / (max - min)) * trackW;
      onChange(newVal);
    };
    knob.on("pointerdown", (e) => { dragging = true; updateKnob(e.global.x); });
    knob.on("pointermove", (e) => { if (dragging) updateKnob(e.global.x); });
    knob.on("pointerup", () => { dragging = false; });
    knob.on("pointerupoutside", () => { dragging = false; });
    settingsPanel.addChild(knob);
    y += 22;
    return y;
  }

  // ── Dropdown helper ──
  function addDropdown(label: string, current: string, options: string[], y: number, x: number, w: number, onChange: (v: string) => void, isStub = false): number {
    const color = isStub ? C_STUB : C_TEXT;
    const lbl = new Text({ text: `${label}: ${current} ▾`, style: { fill: color, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" } });
    lbl.x = x; lbl.y = y;
    lbl.eventMode = "static"; lbl.cursor = "pointer";
    let open = false;
    let dropdownContainer: Container | null = null;
    lbl.onclick = () => {
      if (open) { closeDropdown(); return; }
      open = true;
      dropdownContainer = new Container();
      let dy = y + 18;
      for (const opt of options) {
        const isSel = opt === current;
        const optText = new Text({
          text: isSel ? `▸ ${opt}` : `  ${opt}`,
          style: { fill: isSel ? C_ACCENT : C_TEXT, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" },
        });
        optText.x = x; optText.y = dy;
        optText.eventMode = "static"; optText.cursor = "pointer";
        optText.onclick = () => {
          onChange(opt);
          closeDropdown();
          buildSettingsPanel();
        };
        dropdownContainer!.addChild(optText);
        dy += 16;
      }
      settingsPanel.addChild(dropdownContainer);
    };
    function closeDropdown() {
      if (dropdownContainer) { dropdownContainer.destroy({ children: true }); dropdownContainer = null; }
      open = false;
    }
    settingsPanel.addChild(lbl);
    y += 22;
    return y;
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

    const clearBtn = new Text({ text: "[Clear All Props]", style: { fill: 0xff6666, fontSize: 13, fontFamily: "Segoe UI, Arial, sans-serif" } });
    clearBtn.x = PADDING; clearBtn.y = fy + 8;
    clearBtn.eventMode = "static"; clearBtn.cursor = "pointer";
    clearBtn.onclick = () => postAction({ kind: "clearProps" });
    footerBar.addChild(clearBtn);

    const allItems = getFilteredItems();
    const info = new Text({
      text: `Showing ${Math.min(allItems.length, 200)} of ${allItems.length} items${allItems.length > 200 ? " — use search/filters to narrow" : ""}`,
      style: { fill: C_TEXT_DIM, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" },
    });
    info.x = 180; info.y = fy + 8;
    footerBar.addChild(info);

    const totalSpawned = Object.values(spawnCounts).reduce((a, b) => a + b, 0);
    const totalLabel = new Text({ text: `Total spawned: ${totalSpawned}`, style: { fill: C_ACCENT, fontSize: 12, fontFamily: "Segoe UI, Arial, sans-serif" } });
    totalLabel.x = app.screen.width - 160; totalLabel.y = fy + 8;
    footerBar.addChild(totalLabel);
  }

  // ── Spawn action ──
  function doSpawn(count: number): void {
    if (!selectedContentId) return;
    postAction({ kind: "spawn", contentId: selectedContentId, settings: { ...settings }, count });
  }

  // ── Thumbnail rendering ──
  function initThumbnails(): void {
    if (thumbRenderer) return;
    try {
      thumbRenderer = new ThumbnailRenderer(THUMB_SIZE);
    } catch (err) {
      console.warn("[AssetBrowser] ThumbnailRenderer init failed:", err);
    }
  }

  function updateThumbnails(): void {
    if (!showBrowser || !thumbRenderer) return;
    _thumbFrame++;
    if (_thumbFrame % 60 === 0) {
      const cached = cards.filter((c) => (thumbRenderer as any).cache.has(c.item.id)).length;
      console.log(`[AssetBrowser] updateThumbnails frame=${_thumbFrame}, cards=${cards.length}, cached=${cached}`);
    }
    // Load models for visible cards that haven't been loaded yet (limit concurrency).
    let loadCount = 0;
    const MAX_CONCURRENT_LOADS = 6;
    const pendingLoads = cards.filter((c) => c.container.visible && !c.modelLoaded);
    for (const card of pendingLoads) {
      if (loadCount >= MAX_CONCURRENT_LOADS) break;
      card.modelLoaded = true;
      const item = card.item;
      if (item.modelUri) {
        thumbRenderer.loadModelThumb(item.modelUri, item.id);
      } else if (item.id.includes("sphere") || item.id.includes("ball")) {
        thumbRenderer.loadBuiltinSphere(item.id);
      } else {
        thumbRenderer.loadBuiltinCube(item.id);
      }
      loadCount++;
    }
    if (loadCount > 0) {
      console.log(`[AssetBrowser] Loading ${loadCount} thumbnail models...`);
    }

    // Render thumbnails for visible cards with loaded models.
    const visibleCards = cards.filter((c) => c.container.visible);
    const perFrame = Math.min(visibleCards.length, 12);
    for (let i = 0; i < perFrame; i++) {
      const card = visibleCards[i];
      if (!card) continue;
      card.angle += 0.03; // slow rotation
      if (!thumbRenderer!.has(card.item.id)) continue;
      try {
        const pixels = thumbRenderer.renderThumb(card.item.id, card.angle);
        if (!pixels) continue;
        // putImageData to temp canvas, then drawImage to card canvas (through compositor).
        const imageData = new ImageData(THUMB_SIZE, THUMB_SIZE);
        imageData.data.set(pixels);
        tempThumbCtx.putImageData(imageData, 0, 0);
        card.thumbCtx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
        card.thumbCtx.drawImage(tempThumbCanvas, 0, 0);
        // Bypass update() — emit "update" directly to trigger GPU re-upload.
        const src = card.texture.source as any;
        src.emit("update", src);
      } catch (e) {
        if (!(card as any)._renderErr) {
          (card as any)._renderErr = true;
          console.error(`[AssetBrowser] Render error for "${card.item.id}":`, e);
        }
      }
    }
  }

  // ── Keyboard navigation ──
  function handleKeydown(key: string, code: string): void {
    if (!showBrowser) return;

    // Search text entry
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
        postAction({ kind: "closeBrowser" });
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
      doSpawn(1);
      return;
    }

    // Arrow / WASD navigation
    if (code === "ArrowUp" || code === "KeyW") { moveSelection(0, -1); return; }
    if (code === "ArrowDown" || code === "KeyS") { moveSelection(0, 1); return; }
    if (code === "ArrowLeft" || code === "KeyA") { moveSelection(-1, 0); return; }
    if (code === "ArrowRight" || code === "KeyD") { moveSelection(1, 0); return; }

    // Printable char → search query
    if (key.length === 1 && key >= " " && key <= "~") {
      searchQuery += key;
      searchInput.text = searchQuery;
      scrollY = 0;
      rebuildGrid();
    }
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
    if (show) {
      initThumbnails();
      // Re-send content list request (the main thread should have already sent it)
      if (contentItems.length === 0) {
        // Will be populated when the main thread sends the contentList event
      }
    }
  }

  // ── Initial build ──
  buildBackdrop();
  buildHeader();
  buildTabs();
  buildFilters();
  rebuildGrid();
  buildSettingsPanel();
  buildFooter();

  return {
    root,
    update(data: PixiUiUpdateData) {
      const stats = data.stats as Record<string, number> | undefined;
      const events = data.events as any[] | undefined;

      // Read showBrowser from stats
      const newShow = (stats?.showBrowser ?? 0) !== 0;
      if (newShow !== showBrowser) setShowBrowser(newShow);

      // Process events
      if (events) {
        for (const evt of events) {
          if (evt.kind === "contentList") {
            contentItems = evt.items as ContentListItem[];
            derivePacks();
            scrollY = 0;
            rebuildGrid();
            buildTabs();
            buildFilters();
            buildSettingsPanel();
          } else if (evt.kind === "spawnCounts") {
            spawnCounts = evt.counts as Record<string, number>;
            // Update count badges
            for (const card of cards) {
              const cnt = spawnCounts[card.item.id] ?? 0;
              card.countText.text = `×${cnt}`;
            }
            buildFooter();
            buildSettingsPanel();
          } else if (evt.kind === "keydown") {
            handleKeydown(evt.key, evt.code);
          }
        }
      }

      // Update caret blink
      if (showBrowser) {
        caretBlink += data.dt;
        const showCaret = Math.floor(caretBlink / 0.5) % 2 === 0;
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
    dispose() {
      if (thumbRenderer) { thumbRenderer.dispose(); thumbRenderer = null; }
      for (const c of cards) { c.texture.destroy(true); }
      root.destroy({ children: true });
    },
  };
}
