// ============================================================================
// inspectable.ts — characterCustomizationNodes(): InspectableNode[] exposing
// a CharacterCustomization to automation (MCP inspectable_* tools, devtools).
//
// The nodes write through the game's `apply` callback — the SAME function the
// customization UI calls (store update → resolveCustomizationMeshes → mesh
// re-upload → sim dispatch) — so an agent setting `player.customization.
// variants.ash_torso` produces exactly the in-game effect of a user picking
// that variant.
//
// Group coverage is captured at call time: re-run the helper and re-register
// (the previous registerAll() unsubscribe makes this one line) after a model
// swap changes the group set. Option lists stay fresh within a fixed set —
// `enum` and `get` re-resolve the catalog lazily.
// ============================================================================

import type { InspectableNode } from "@downdraft/engine/libraries/inspectable";
import {
    customizableGroups,
    effectiveVariantKey,
    slotLabel,
    type CharacterCustomization,
    type VariantCatalog,
    type VariantGroup,
} from "./customization";

/** Sentinel enum value standing in for a `null` variant pick (hidden group). */
export const CUSTOMIZATION_NONE = "<none>";

export interface CharacterCustomizationNodesOptions {
    /** Path prefix for the emitted nodes. Default "player.customization". */
    prefix?: string;
    /** The model's variant catalog, or a lazy accessor returning null before
     *  the model loads. Variant-group nodes are emitted for the groups
     *  `customizableGroups` reports at call time. */
    catalog: VariantCatalog | (() => VariantCatalog | null);
    /** Read the live customization (e.g. `() => store.getState().player.customization`). */
    get: () => CharacterCustomization;
    /** Apply a changed customization — pass the same function the game's
     *  customizer UI calls. */
    apply(next: CharacterCustomization): void;
}

export function characterCustomizationNodes(opts: CharacterCustomizationNodesOptions): InspectableNode[] {
    const prefix = opts.prefix ?? "player.customization";
    const catalog = () => (typeof opts.catalog === "function" ? opts.catalog() : opts.catalog);
    const patch = (update: Partial<CharacterCustomization>) => opts.apply({ ...opts.get(), ...update });

    const nodes: InspectableNode[] = [
        {
            path: `${prefix}.girth`,
            label: "Body girth",
            description: "Horizontal body-width scale delta; 0 = authored shape.",
            type: "number",
            min: -1,
            max: 1,
            get: () => opts.get().girth ?? 0,
            set: (v) => patch({ girth: v as number }),
        },
        {
            path: `${prefix}.tints`,
            label: "Material tints",
            description: "Whole tint map (material name → linear RGB 0-1 triple).",
            type: "json",
            get: () => opts.get().tints,
            set: (v) => patch({ tints: v as CharacterCustomization["tints"] }),
        },
        {
            path: `${prefix}.textures`,
            label: "Material textures",
            description: "Whole texture map (material name → texture asset path).",
            type: "json",
            get: () => opts.get().textures,
            set: (v) => patch({ textures: v as CharacterCustomization["textures"] }),
        },
    ];

    for (const group of customizableGroups(catalog() ?? { groups: [], byKey: new Map() })) {
        nodes.push(variantNode(prefix, group, catalog, opts.get, patch));
    }
    return nodes;
}

function variantNode(
    prefix: string,
    groupAtEmit: VariantGroup,
    catalog: () => VariantCatalog | null,
    get: () => CharacterCustomization,
    patch: (u: Partial<CharacterCustomization>) => void,
): InspectableNode {
    // Group lookups re-resolve the catalog so a rebuilt catalog (same group
    // set, refreshed variants) is honored without re-registration.
    const group = () => catalog()?.byKey.get(groupAtEmit.key) ?? groupAtEmit;
    const allowsNone = () => group().kind !== "required";
    const options = () => {
        const keys = group().variants.map((v) => v.key);
        return allowsNone() ? [...keys, CUSTOMIZATION_NONE] : keys;
    };
    return {
        path: `${prefix}.variants.${groupAtEmit.key}`,
        label: groupAtEmit.label,
        description: `Variant pick for the ${slotLabel(groupAtEmit.key)} slot`,
        type: "enum",
        enum: options,
        get: () => effectiveVariantKey(group(), get()) ?? CUSTOMIZATION_NONE,
        set: (v) => {
            const cust = get();
            patch({ variants: { ...cust.variants, [groupAtEmit.key]: v === CUSTOMIZATION_NONE ? null : (v as string) } });
        },
    };
}
