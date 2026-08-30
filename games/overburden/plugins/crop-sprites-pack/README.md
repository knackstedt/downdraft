# overburden-crop-sprites-pack

Sample user-authored plugin for **Overburden** (Downdraft Engine).

- **Format:** `asset` (data-only, no code)
- **Tier:** `data` (no permissions, no runtime API access)
- **Thread:** `renderer` (assets load on the renderer thread)

## What it does

Adds a **Golden Wheat** crop sprite texture + a crop data JSON. The asset loader registers the plugin directory as an `AssetManager` search path and eagerly loads the declared textures + data files. The game can then query `AssetManager.get("tex/golden-wheat")` to retrieve the texture and `AssetManager.get("data/golden-wheat-crop")` for the crop definition.

## Demonstrates

- Data-tier asset plugin: no code entry, just a `plugin.json` manifest with an `assets` section.
- `AssetPluginLoader`: search-path registration, eager asset loading, clean unload.
- The `provides` stringly-typed key (`overburden:asset/crop-sprites`) so other plugins can `requires` it.

## Files

- `plugin.json` — manifest declaring the asset files.
- `assets/golden-wheat.png` — placeholder texture (1×1 golden pixel).
- `assets/golden-wheat-crop.json` — crop definition (growth timing, drops, seed item).
