// @downdraft/library-sand — reusable falling-sand simulation primitives.
//
// Extracted from games/falling-sand/ so multiple games (falling-sand, mining-rpg)
// share the same material definitions, cell packing, and SandWorld simulation.
// Games keep their own SharedArrayBuffer/worker wiring but import the core
// sim types and the SandWorld class from here.

export {
    FLAG_SPARK,
    FLAG_UPDATED,
    FLAG_UPDATED_BIT,
    pack,
    packCell,
    randomShade,
    SHADE_MASK,
    unpack,
    type Cell
} from "./cell";

export {
    DEFAULT_GRAVITY,
    DEFAULT_TEMP,
    DEFAULT_WIND,
    FIELD
} from "./fields";

export {
    buildMaterialProps,
    buildPalette,
    PALETTE_SIZE,
    SHADES_PER_MATERIAL
} from "./palette";

export {
    getMaterialColor,
    IS_FIRE,
    IS_HOT,
    MAT_DENSITY,
    MAT_FLAGS,
    MAT_FLAMMABLE,
    MAT_GAS,
    MAT_GRAVITY,
    MAT_GRAVITY_DIR,
    MAT_LIFETIME,
    MAT_LIQUID,
    MAT_MAGNETIC,
    MAT_SOLID,
    Material,
    MATERIALS,
    MAX_MATERIAL
} from "./materials";
export type { MaterialDef } from "./materials";

export { SandWorld } from "./sand-world";
