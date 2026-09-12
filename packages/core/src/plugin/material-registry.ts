// ============================================================================
// MaterialRegistry — mod-defined material shaders for spawned props.
//
// Mods register custom WGSL material shaders via the ShaderRegistry extension
// loader. The MaterialRegistry tracks registered materials and provides
// lookup by id. The renderer integrates with this registry to apply custom
// materials to spawned props.
//
// This is a lightweight, testable registry. The actual GPU pipeline creation
// + bindless material integration happens in the renderer when a prop is
// spawned with a custom material id (the renderer looks up the material in
// this registry and compiles the WGSL on demand).
// ============================================================================

/** A registered mod-defined material shader. */
export interface RegisteredMaterial {
  /** Unique material id (namespaced, e.g. "my-mod:iridescent"). */
  id: string;
  /** WGSL material shader source. */
  wgsl: string;
  /** The mod that registered this material. */
  manifestId: string;
  /** Uniform buffer size in bytes (if the shader needs a uniform). */
  uniforms?: number;
  /** Extra properties from the extension declaration. */
  props: Record<string, unknown>;
}

/** Registry for mod-defined material shaders. */
export class MaterialRegistry {
  private materials = new Map<string, RegisteredMaterial>();

  /** Register a material shader. Throws if the id is already registered. */
  register(material: RegisteredMaterial): void {
    if (this.materials.has(material.id)) {
      throw new Error(`Material "${material.id}" is already registered`);
    }
    this.materials.set(material.id, material);
  }

  /** Unregister a material by id. */
  unregister(id: string): void {
    this.materials.delete(id);
  }

  /** Get a registered material by id. Returns undefined if not found. */
  get(id: string): RegisteredMaterial | undefined {
    return this.materials.get(id);
  }

  /** Check if a material is registered. */
  has(id: string): boolean {
    return this.materials.has(id);
  }

  /** Get all registered material ids. */
  ids(): string[] {
    return [...this.materials.keys()];
  }

  /** Clear all registered materials. */
  clear(): void {
    this.materials.clear();
  }
}
