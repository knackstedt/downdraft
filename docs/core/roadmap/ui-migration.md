# UI Migration Roadmap: to-the-ocean → Engine UI System

## Current State

- **to-the-ocean** uses React + Tailwind CSS + Zustand for all UI (17 components, ~130KB source)
- **Engine UI system** has basic elements (panel, text, button, image), bitmap font, simple layout, basic input
- to-the-ocean's `WebGPURenderer` does NOT use `@downdraft/core`'s `RenderLoop`

## Phase 1: Extend Engine UI System

Before any migration can begin, the engine UI system needs these capabilities:

### 1a. Canvas-based Text Rendering (replace bitmap font)
- Current 8×12 bitmap font only supports ASCII 32–126
- Components use emoji (🌙☀️🪶🎣🔨), custom fonts (Doto, Montserrat, etc.), multiple sizes
- **Plan**: Render text to offscreen Canvas2D, upload as texture, draw as textured quads
- Text wrapping, multi-line, text measurement via `ctx.measureText()`
- Font cache (font family + size → cached canvas texture atlas)

### 1b. Scroll Container + Clip Rectangles
- Needed by: Inventory, CraftMenu, SettingsPanel, BuilderWheel, MapView
- GPU scissor rect support for clipping
- Scroll offset tracking, scrollbar widget
- Mouse wheel event routing

### 1c. Text Input Field
- Needed by: SettingsPanel (keybindings), search/filter in CraftMenu
- Cursor positioning, text selection, clipboard
- Focus management (only one input focused at a time)
- Character insertion/deletion via keyboard events

### 1d. Layout Extensions
- Grid layout (for inventory slots) — rows, columns, spans
- Flexbox-like layout (justify, align, gap, grow/shrink)
- Z-ordering within parent
- Min/max width/height constraints

### 1e. Widget Library
- **ProgressBar** — health/hunger/thirst/oxygen bars, loading bar
- **Slider** — volume controls, sensitivity, render distance
- **Toggle/Checkbox** — boolean settings
- **TabBar** — settings tabs, inventory tabs
- **Modal/Dialog** — backdrop dim, click-outside-to-close, focus trap
- **Scrollbar** — vertical/horizontal, drag handle

### 1f. Line/Path Rendering
- Needed by: Reticule (SVG line segments with tweening)
- Line list rendering with color, width
- Basic 2D path support (arcs, curves)

### 1g. Animation System
- Property tweening (opacity, position, scale, rotation)
- Easing functions (ease-in-out, linear, etc.)
- Per-element animation state, completion callbacks
- Needed by: Reticule (shape morphing), BuilderWheel (expand/collapse)

## Phase 2: Integration with to-the-ocean

### 2a. Wire UIRenderer into WebGPURenderer
- to-the-ocean has its own `WebGPURenderer` that doesn't use `@downdraft/core`'s `RenderLoop`
- Add `UIRenderer` + `UIInputRouter` fields to `WebGPURenderer`
- Create `UIRoot` in renderer init, execute UI pass at end of frame
- Bridge mouse/keyboard events from existing input handlers to `UIInputRouter`

### 2b. State Bridge
- Create adapter between Zustand stores and UI element tree
- Reactive updates: store change → update UI element properties
- One-way: store → UI (UI events → store actions via callbacks)

## Phase 3: Simple Components (lowest risk)

| Component | Size | Features Needed |
|---|---|---|
| LoadingScreen | 1KB | ProgressBar, centered text |
| NotificationStack | 1KB | Text, fade animation, vertical stack |
| DeathScreen | 2KB | Modal, text, button |

## Phase 4: HUD

| Component | Size | Features Needed |
|---|---|---|
| HUD | 13KB | ProgressBar, text, hotbar grid, fishing minigame bars |
| Reticule | 7KB | Line rendering, animation/tweening |

## Phase 5: Medium Components

| Component | Size | Features Needed |
|---|---|---|
| PauseMenu | 2KB | Modal, buttons |
| BuildMenu | 2KB | Buttons, text |
| TradeMenu | 4KB | Text, buttons, grid layout |
| CharacterCustomization | 4KB | Text, buttons, color picker |
| FishingMinigame | 3KB | ProgressBar, text, animation |

## Phase 6: Complex Components

| Component | Size | Features Needed |
|---|---|---|
| Inventory | 11KB | Grid layout, scroll, tabs, tooltips (floating), drag transfer |
| CraftMenu | 27KB | Scroll, tabs, search input, item grids, recipe display |
| MapView | 26KB | Canvas/image rendering, zoom/pan, waypoints |
| SettingsPanel | 28KB | Tabs, sliders, toggles, text input, scroll |

## Phase 7: Remaining Components

| Component | Size | Features Needed |
|---|---|---|
| BuilderWheel | 6KB | Accordion, grid, hover expand, animation |
| CreditsScreen | 6KB | Scroll, text, animation |
| DebugPage | 7KB | Text, tables, scroll (may keep as React DevTools panel) |

## Migration Strategy

- **Gradual**: migrate one component at a time, keep React for others
- **Coexistence**: React DOM overlay and GPU UI can coexist — React for menus, GPU for HUD
- **Toggle**: add a flag to switch between React and GPU UI per component for A/B testing
- **State**: both read from the same Zustand stores, so state is shared

## Risk Assessment

- **High risk**: CraftMenu (27KB), SettingsPanel (28KB), MapView (26KB) — complex, may need extended engine features
- **Medium risk**: Inventory (floating tooltips via @floating-ui), BuilderWheel (accordion animation)
- **Low risk**: LoadingScreen, NotificationStack, DeathScreen, PauseMenu, BuildMenu
- **Special**: Reticule (SVG line tweening), DebugPage (may stay as DevTools panel)
