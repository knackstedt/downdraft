# Andrew's Sandbox Plugins

Plugins are user-authored content extensions discovered at runtime.

## Plugin Types

### Asset Plugins (data-tier)
Provide meshes, textures, and data files. Discovered via `plugin.json` in
each plugin directory. The content registry scans for `plugins/*/plugin.json`
and registers declared assets as spawnable content.

### Script Plugins (script-tier)
Provide game logic via JavaScript. Not yet fully implemented in v1.

## Directory Structure

```
plugins/
  crate-pack/
    plugin.json
    assets/
      crate.glb
  bouncy-ball/
    plugin.json
    physics.json
```

## plugin.json Format

```json
{
  "id": "unique-plugin-id",
  "name": "Display Name",
  "version": "1.0.0",
  "author": "Author Name",
  "description": "Description",
  "engineVersion": "^0.1.0",
  "game": "andrews-sandbox",
  "format": "asset",
  "tier": "data",
  "thread": "renderer",
  "permissions": [],
  "provides": ["andrews-sandbox:prop/my-prop"],
  "requires": [],
  "dependencies": [],
  "assets": {
    "files": {},
    "meshes": ["./assets/model.glb"],
    "textures": [],
    "audio": [],
    "data": []
  }
}
```

## Included Examples

- **crate-pack**: Asset plugin that adds a crate prop model.
- **bouncy-ball**: Asset plugin that adds a high-bounciness ball with custom physics data.
