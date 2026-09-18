# UI Migration Roadmap: to-the-ocean → Engine UI System

## Current State

- **to-the-ocean** uses React + Tailwind CSS + Zustand for all UI components (`.tsx` files in `src/components/`)
- **Engine UI system** (`packages/engine/core/src/ui/`) is fully built out with all Phase 1 capabilities
- to-the-ocean's `WebGPURenderer` is wired into the engine UI system (`UIRenderer`, `UIRoot`, `UIInputRouter` integrated in `webgpu-renderer.ts` + `renderer-accessors.ts` + `renderer-input-handler.ts`)
- **No React components have been migrated to the GPU UI yet** — coexistence phase

## Phase 1: Extend Engine UI System (DONE)

All capabilities are implemented in `packages/engine/core/src/ui/`:

- **Canvas-based text rendering** — `text-cache.ts` + `glyph-atlas.ts` (text → Canvas2D → texture)
- **Scroll container + clip rectangles** — `scroll.ts` (GPU scissor rects, scroll offset, mouse wheel)
- **Text input field** — `UITextInput` in `widgets.ts` (cursor, selection, focus management)
- **Layout engine** — `layout.ts` (grid, flex-like, z-ordering, min/max constraints)
- **Widget library** — `widgets.ts`: `UIProgressBar`, `UISlider`, `UIToggle`, `UITabBar`, `UIModal`, `UITextInput`
- **Line/path rendering** — `UILine` in `element.ts`, `line-list` topology in `renderer.ts`
- **Animation system** — `animation.ts` with `Easing` functions, `UIAnimationManager`

## Phase 2: Integration with to-the-ocean

### 2a. Wire UIRenderer into WebGPURenderer (DONE)
`UIRenderer`, `UIRoot`, `UIInputRouter` are integrated in `webgpu-renderer.ts`. Mouse/keyboard
events bridged from `renderer-input-handler.ts` to `UIInputRouter`.

### 2b. State Bridge (NOT STARTED)
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
