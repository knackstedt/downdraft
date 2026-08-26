# FBX loader visual-test models

A deterministic suite of small FBX files exercising the Babylon.js FBX loader's feature surface.
Each file is authored programmatically (binary FBX, v7500) and validated against the real Autodesk
FBX SDK, so it opens correctly in Maya as well as the Babylon loader.

Generator (not in this repo): `babylon-fbx/tools/fbx-test-generator`.

`fbxVisualTests.js` is the scene-creation script for the Babylon.js visual-regression suite: it loads
each model here, frames it with the validated per-model camera + a neutral light rig, renders
single-sided, and pins animations to a deterministic frame. The Babylon.js FBX loader PR references
its functions via the visualization `config.json` (`scriptToRun` + `functionToCall`). NOTE: fbx2gltf
drops FBX skeletal animation, so the SDK/Maya-proxy render of `m12_skeletal_anim` shows the rest pose
(straight); the Babylon loader (and real Maya, when scrubbed) shows the bend.

## Conventions / expectations
- **Single-sided**: meshes are wound so the outward face is front-facing. Render with backface
  culling on; a regression that flips winding/normals will show backfaces (inside-out).
- **Axis**: M16 includes genuinely Z-up and Y-up authorings. The Babylon loader converts both to the
  engine's Y-up space, so all three M16 files load identically. (Maya does NOT convert on import, so
  the Z-up file looks rotated there — that is the proof it is genuinely Z-up.)
- **Cameras/lights** (M15): FBX cameras look down local +X, lights down local -Z; both are aimed at
  the subject. View M15 through its own perspective camera.

## Models
| File | Exercises | Expected |
| --- | --- | --- |
| m01_cube_phong | basic mesh, Phong material, per-face normals/UVs | lit cube |
| m02_geo_ngons | n-gon triangulation (tri/quad/hex/concave arrow), vertex colors | flat panel of colored polygons (enable vertex-color display in Maya) |
| m03_normals | smooth vs flat (hard-edged) shading on two spheres | left smooth, right faceted; no pole holes |
| m04_material_properties | Lambert/Phong, specular, emissive, ambient, opacity | row of spheres with distinct shading |
| m05_textures | texture slots: diffuse, normal (debossed F), emissive, opacity (holes), external sidecar | row of textured quads (needs `m05_external_diffuse.png`) |
| m06_uv_transform | per-texture UV translation + scaling | tiled/offset checker on a plane |
| m07_multimaterial | per-polygon material indices → submesh splitting | cube with 3 colored face-pairs (red/green/blue) |
| m08_transforms | TRS chain, pre/post-rotation, pivots/offsets, geometric transform | scattered colored cubes |
| m09_skinning | skeleton + clusters + weights + bind pose (static bent rest) | smoothly bent cylinder |
| m10_morph | morph targets + in-between shapes (static deform) | flat plane with a raised central hill |
| m11_node_anim | node animation (const/linear/cubic keys) | three posed cubes at the sampled frame |
| m12_skeletal_anim | skeletal animation over time | cylinder bent at the sampled frame |
| m13_morph_anim | DeformPercent animation | plane hill at the sampled frame |
| m14_multiclip | multiple AnimationStacks → two clips ("Spin", "Bounce") | one cube; two animation groups |
| m15_camera_lights | point/spot/directional lights + perspective/orthographic cameras, all aimed at the subject | lit sphere + ground, green spot pool, viewed through the FBX camera |
| m16_axis_yup / m16_axis_zup / m16_units_254 | GlobalSettings axis conversion + unit scale | all three load identically (RGB gizmo, green up) |

`.fbm` folders are texture-extraction artifacts created by SDK tools (Maya/fbx2gltf) when loading
embedded-texture files; they are gitignored.
