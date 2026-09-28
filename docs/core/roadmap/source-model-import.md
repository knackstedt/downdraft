# Source Engine (SFM/GMod) Model Import — Roadmap

## Current State

- The engine models library (`@downdraft/engine/libraries/models`) loads glTF/GLB, FBX,
  OBJ, DAE, and other interchange formats — but **not** compiled Source Engine models.
- Source Filmmaker / GMod model packs (e.g. `~/Downloads/Jack Mugen SFM model/`) ship as
  the compiled Valve trio:
  - `.mdl` — StudioMDL binary (bones, skin, flexes, hitboxes, LODs, bodygroups)
  - `.vvd` — vertex data (positions, normals, UVs, weights)
  - `.dx90.vtx` — DX9 mesh topology the GPU renders
  - `.vtf` / `.vmt` — Valve textures + material definitions (`VertexLitGeneric`, phong, rimlight)
- These packs use the `usermod/` content-mount layout (`Models/` + `Materials/` roots).
- No direct loader exists anywhere in our stack — the supported path is **offline
  conversion to GLB**, then load via the models library like any other asset.

## Phase 1: Manual CLI recipe (working today)

### Tooling: Blender 4.0+ + SourceIO addon

**SourceIO** (`github.com/REDxEYE/SourceIO`) parses compiled `.mdl`/`.vvd`/`.vtx` directly
and converts `.vtf`/`.vmt` materials in memory — no Crowbar decompile step. Runs fully
headless via `blender -b -P`.

One-time install:

```bash
# Download latest release zip from github.com/REDxEYE/SourceIO/releases, then:
unzip SourceIO-<ver>.zip -d ~/.config/blender/<ver>/scripts/addons/
# or: blender -b -P install.py  ->  bpy.ops.preferences.addon_install(filepath=zip)
```

### Conversion script

```python
# convert.py — run with: blender -b --factory-startup -P convert.py -- <in.mdl> <out.glb>
import bpy, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = os.path.abspath(argv[0]), argv[1]
d, f = os.path.split(src)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.preferences.addon_enable(module="SourceIO")

bpy.ops.sourceio.mdl(
    filepath=src,
    directory=d,            # required on Blender >= 4.1
    files=[{"name": f}],    # required — normally filled by the file picker
    import_textures=True,
    bodygroup_grouping=True,
    create_flex_drivers=True,  # optional: HMW-style flex drivers
)

bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB")
```

```bash
blender -b --factory-startup -P convert.py -- \
  "/path/to/usermod/Models/nexgen/ocs/nexgen_jackmugen.mdl" \
  /tmp/jackmugen.glb
```

### Pitfalls (learned)

- The `sourceio.mdl` operator iterates `self.files`, which is normally populated by the
  file-select dialog. Headless, you **must** pass `files=[{"name": ...}]` (and `directory`
  on Blender >= 4.1) or it silently imports nothing.
- `discover_resources=True` (default) scans upward from the model path for
  `models/`+`materials/` content roots. Packs that capitalize `Models`/`Materials` may fail
  to resolve textures on case-sensitive Linux — symlink lowercase `models`/`materials` dirs
  and retry if materials come in gray/missing.
- Flexes import as **shape keys**; `create_flex_drivers` adds HMW-style drivers.
  `import_animations=True` pulls baked sequences from the .mdl.
- `.phy` (collision) is often absent from character packs — no ragdoll data to convert.

### Alternative (no Blender): GMConverter CLI

`gmod-workshop/gmconverter` is a standalone .NET CLI — Source 1 MDL in, GLB out:

```bash
GMConverter.CLI --input-format mdl --output-format glb \
  --input-path model.mdl --output-path out/
```

Less flexible (no bone/material fixup pass), but zero GUI deps. Same MDL v48/49 family as
SFM/GMod.

## Phase 2: Wrap as an engine/script command

- Script `scripts/import-source-model.mjs` (or a `draft` subcommand) that shells out to
  headless Blender, so a model pack → game-ready GLB is one command.
- Output convention: `games/<game>/assets/models/<name>.glb` + manifest entry.
- Optional: auto-normalize scale (Source hammer units → meters is handled by SourceIO's
  `scale` option, default already converts).

## Phase 3: Post-import normalization

- Bake Source material params (phong/rimlight/halflambert) down to the engine's PBR model
  — SourceIO gives Blender `VertexLitGeneric` nodes; the glTF exporter emits standard
  metallic-roughness approximations.
- Verify flex/shape-key names survive the GLB round-trip and map them onto the engine's
  facial/expression system if the game needs it.
- LOD selection: Source LODs collapse to separate meshes in the GLB — pick LOD0 or wire
  into the engine LOD system.

## Phase 4 (speculative): native MDL reader in `libraries/models`

- A `mdl.ts` loader (parse MDL header + VVD + VTX) would drop the Blender dependency
  entirely. Only worth it if Source-pack ingestion becomes frequent — the Blender path is
  fine for occasional imports.
