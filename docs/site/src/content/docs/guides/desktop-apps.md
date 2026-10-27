---
title: Desktop Applications
description: Building desktop apps on DownDraft — windows, menus, tray, dialogs, settings, damage-driven rendering
---

DownDraft doubles as a desktop-app platform: the same native runtime
(winit + wgpu) that renders app surfaces hosts full desktop applications
with OS menus, tray icons, native dialogs, and per-app settings. Scaffold
one with:

```bash
draft new my-app --template app
```

## The app module

A desktop app is an `AppModule` without a sim worker — everything lives on
the main thread:

```ts
export const appModule: AppModule = {
  renderer: (canvas) => {
    const r = new AppRenderer(canvas, {
      mode: "2d",
      damageOnly: true,                    // frames only on change
      clearColor: { r: 0.12, g: 0.12, b: 0.14, a: 1 },
    });
    r.setViewportCount(0);                 // no scene viewports
    return r;
  },
  onReady(ctx) {
    ctx.renderer.useRendererModule?.(createHtmlUi({
      build(ui) {
        const doc = ui.mount(markup, {
          id: "app",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          fit: true,                        // always covers the surface
        });
        bindKit(doc, { onAction: handleAction });
      },
    }));
  },
};
```

`damageOnly` skips the whole GPU block (acquire → encode → submit → present)
on ticks where nothing reported damage, and disarms the rAF chain down to a
low-rate keepalive (`damageIdleFps`, default 20 Hz, `0` = sleep fully).
Damage sources — html-ui repaints, pointer/wheel/key input, resize —
re-arm the chain immediately via `requestFrame()`. This is the single most
important switch for a desktop app: without it the renderer composites the
same frame at display refresh forever.

## Windows

`AppWindow` (`@downdraft/platform-native`) is the app-facing window
abstraction — `AppWindow.primary()`, `AppWindow.list()`,
`AppWindow.create({...})`. Runtime controls work on any window handle:
`setTitle`, `setSize`, `minimize`, `maximize`, `setVisible`, `focus`,
`setFullscreen`, `setDecorations`, `setAlwaysOnTop`, `setResizable`,
`setMinSize`/`setMaxSize`, `requestAttention`, `getTheme`.

Primary-window creation accepts the same options through
`runNativeAppModule` → `NativeWindowConfig` (`x`, `y`, `resizable`,
`decorations`, `alwaysOnTop`, `skipTaskbar`, `hidden`, `minWidth`,
`minHeight`, `maxWidth`, `maxHeight`, `iconPath`).

Window position/size/maximized state is persisted to
`<configDir>/window-state.json` and restored on next launch.

## Lifecycle and close veto

`runNativeAppModule(module, opts)`:

- `closePolicy: "lastWindow"` (default) — an accepted close quits the
  process. `"explicit"` — closing hides the window; the process stays
  alive until `downdraft.quit()` (tray apps).
- `onCloseRequest(win)` — sync or async veto hook; return `false` to keep
  the window mapped. The window emits a cancelable `"closerequest"` event
  when the intercept is armed — any `preventDefault()` wins over the
  policy default.
- `focusOnSecondInstance` (default `true`) — a forwarded second launch
  unhides and focuses the primary window.

## Menus

`downdraft.setMenu(model)` installs a real OS menu on Windows (HMENU) and
macOS (NSMenu). On Linux it returns `"inwindow"` — render the kit
`menuBar(model)` inside your html-ui document instead:

```ts
const backend = downdraft.setMenu?.(MODEL);   // "native" | "inwindow" | "unavailable"
// render kit menuBar(MENU) in the doc when backend === "inwindow"
downdraft.onMenuAction((id) => { /* id from the model */ });
downdraft.setMenuItemChecked("view.dark", dark);
downdraft.showContextMenu(x, y, MODEL);       // native popup where supported
```

The model (`AppMenuModel`) supports `item`, `check`, `separator`,
`predefined` (OS-supplied items: copy/paste/quit/about/services…), and
nested `submenu`s, with muda-syntax accelerators (`"CmdOrCtrl+O"`). Set
`DD_MENU=inwindow` to force the kit fallback for testing.

## Tray

`downdraft.tray` is a namespaced API over the `dd_tray_*` FFI group:

```ts
const ok = downdraft.tray?.create({
  icon: "/abs/path/icon.png",
  tooltip: "My App",
  menu: { items: [{ id: "quit", label: "Quit" }] },
  menuOnLeftClick: false,
});
downdraft.tray?.onEvent((e) => { /* click/doubleClick/enter/move/leave */ });
downdraft.tray?.onAction((id) => { /* menu item id, prefix stripped */ });
```

On Linux the tray uses the `ksni` backend — a pure-DBus
StatusNotifierItem, so it works on KDE/GNOME/XFCE without installing
libappindicator. Where no SNI watcher exists, `create` returns `false`.
Tray menu ids also appear on `downdraft.onMenuAction` prefixed `tray:`.

## Single instance

Each `appId` holds a singleton lock (`<configDir>/singleton.lock`). A
second launch forwards `{ argv, cwd }` to the primary instance
(`downdraft.onSecondInstance`) and exits; the default reaction raises and
focuses the primary window. `DOWNDRAFT_MULTI_INSTANCE=1` and
`DOWNDRAFT_DETERMINISTIC=1` bypass the lock.

## Dialogs, notifications, theme

- `downdraft.showOpenDialog` / `showSaveDialog` / `pickFolder` — detached
  `rfd` pickers; resolve `null` on cancel.
- `downdraft.showMessageBox({ title, message, level, buttons })` → pressed
  index.
- `downdraft.notify({ title, body, icon })` — OS notification.
- `downdraft.getTheme()` / `onThemeChanged(cb)` — system light/dark.
- `DD_DIALOGS_MOCK=1` resolves every picker with `DD_DIALOGS_MOCK_PATH` in
  tests.

## Paths and settings

`downdraft.paths` = `{ configDir, dataDir, cacheDir }` resolved per
platform convention (XDG dirs on Linux, `%APPDATA%`/`%LOCALAPPDATA%` on
Windows, `~/Library` on macOS). The legacy "userData" dir is `configDir`.

`downdraft.settings` is a typed KV store over `<configDir>/settings.json`:

```ts
downdraft.settings.get("theme", "light");        // fallback
downdraft.settings.set("theme", "dark");         // JSON values only
downdraft.settings.getAll();
const off = downdraft.settings.watch("theme", cb);
downdraft.settings.flush();                       // force the debounced write
```

Writes are debounced (~200 ms) and atomic (tmp + rename); the file carries
a `schemaVersion` for future migrations. `set(key, undefined)` removes the
key. `watch` fires on same-process `set` calls only.

## Authoring checklist

1. `downdraft.config.json`: unique `native.appId`, `native.title`,
   `"gpu": { "mode": "stability" }` for a UI app.
2. `renderer`: `mode:"2d"`, `setViewportCount(0)`, `damageOnly:true`,
   explicit `clearColor`.
3. One `fit:true` html-ui doc; kit `menuBar` when `setMenu` returns
   `"inwindow"`.
4. `closePolicy`/`onCloseRequest` matching the app's close semantics.
5. Optional: tray icon, settings persistence, second-instance handling.
