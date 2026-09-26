import { describe, it, expect } from "bun:test";
import {
  DEFAULT_VARIANT_FLAGS,
  permutationCount,
  variantKey,
  withVariant,
  type MaterialVariantFlags,
} from "./variants";

describe("MaterialVariantFlags", () => {
  it("DEFAULT_VARIANT_FLAGS should have sensible defaults", () => {
    expect(DEFAULT_VARIANT_FLAGS.shadowCaster).toBe(false);
    expect(DEFAULT_VARIANT_FLAGS.skinning).toBe(false);
    expect(DEFAULT_VARIANT_FLAGS.alphaMode).toBe("opaque");
    expect(DEFAULT_VARIANT_FLAGS.morph).toBe(false);
    expect(DEFAULT_VARIANT_FLAGS.instanced).toBe(false);
    expect(DEFAULT_VARIANT_FLAGS.fog).toBe(true);
  });

  it("variantKey should be deterministic for the same flags", () => {
    const a = variantKey(DEFAULT_VARIANT_FLAGS);
    const b = variantKey(DEFAULT_VARIANT_FLAGS);
    expect(a).toBe(b);
  });

  it("variantKey should differ for shadowCaster", () => {
    const base = variantKey(DEFAULT_VARIANT_FLAGS);
    const shadow = variantKey(withVariant(DEFAULT_VARIANT_FLAGS, { shadowCaster: true }));
    expect(base).not.toBe(shadow);
    expect(shadow).toContain("sc");
  });

  it("variantKey should differ for skinning", () => {
    const base = variantKey(DEFAULT_VARIANT_FLAGS);
    const skinned = variantKey(withVariant(DEFAULT_VARIANT_FLAGS, { skinning: true }));
    expect(base).not.toBe(skinned);
    expect(skinned).toContain("sk");
  });

  it("variantKey should differ for alphaMode", () => {
    const opaque = variantKey(DEFAULT_VARIANT_FLAGS);
    const clip = variantKey(withVariant(DEFAULT_VARIANT_FLAGS, { alphaMode: "clip" }));
    const blend = variantKey(withVariant(DEFAULT_VARIANT_FLAGS, { alphaMode: "blend" }));
    expect(opaque).not.toBe(clip);
    expect(opaque).not.toBe(blend);
    expect(clip).not.toBe(blend);
  });

  it("variantKey should NOT include fog (dynamic branch)", () => {
    const noFog = variantKey(DEFAULT_VARIANT_FLAGS);
    const withFog = variantKey(withVariant(DEFAULT_VARIANT_FLAGS, { fog: false }));
    expect(noFog).toBe(withFog);
  });

  it("variantKey should differ for morph", () => {
    const base = variantKey(DEFAULT_VARIANT_FLAGS);
    const morph = variantKey(withVariant(DEFAULT_VARIANT_FLAGS, { morph: true }));
    expect(base).not.toBe(morph);
    expect(morph).toContain("mo");
  });

  it("variantKey should differ for instanced", () => {
    const base = variantKey(DEFAULT_VARIANT_FLAGS);
    const instanced = variantKey(withVariant(DEFAULT_VARIANT_FLAGS, { instanced: true }));
    expect(base).not.toBe(instanced);
    expect(instanced).toContain("in");
  });

  it("permutationCount should be 48 (2*2*3*2*2)", () => {
    expect(permutationCount()).toBe(48);
  });

  it("withVariant should merge partial overrides", () => {
    const merged = withVariant(DEFAULT_VARIANT_FLAGS, { skinning: true, fog: false });
    expect(merged.skinning).toBe(true);
    expect(merged.fog).toBe(false);
    // Untouched fields preserved.
    expect(merged.shadowCaster).toBe(false);
    expect(merged.alphaMode).toBe("opaque");
  });

  it("withVariant should not mutate the base", () => {
    const base: MaterialVariantFlags = { ...DEFAULT_VARIANT_FLAGS };
    withVariant(base, { skinning: true });
    expect(base.skinning).toBe(false);
  });

  it("variantKey should produce unique keys for all 48 permutations", () => {
    const keys = new Set<string>();
    [false, true].forEach((sc) => {
      [false, true].forEach((sk) => {
        (["opaque", "clip", "blend"] as const).forEach((am) => {
          [false, true].forEach((mo) => {
            [false, true].forEach((inn) => {
              const key = variantKey({ ...DEFAULT_VARIANT_FLAGS, shadowCaster: sc, skinning: sk, alphaMode: am, morph: mo, instanced: inn });
              keys.add(key);
            });
          });
        });
      });
    });
    expect(keys.size).toBe(48);
  });
});
