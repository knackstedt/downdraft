// ============================================================================
// @andrews-sandbox/library-props — prop definitions and instance tracking.
// Props are physics-enabled entities that can be spawned, grabbed, painted.
// ============================================================================

import type { ContentEntry } from "@andrews-sandbox/library-content";

export interface PropDefinition {
  id: string;
  name: string;
  category: string;
  modelUri: string;
  thumbnailUri?: string;
  defaultPhysics: {
    mass: number;
    restitution: number;
    friction: number;
    gravityScale: number;
  };
  defaultScale: number;
  paintable: boolean;
}

export interface PropInstance {
  entityId: number;
  nodeId: string;
  contentId: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
  paintable: boolean;
}

/** Convert a ContentEntry to a PropDefinition. */
export function contentToPropDef(entry: ContentEntry): PropDefinition {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    modelUri: entry.modelUri ?? "",
    thumbnailUri: entry.thumbnailUri,
    defaultPhysics: entry.physics,
    defaultScale: entry.scale,
    paintable: entry.paintable,
  };
}

/** Built-in prop definitions (always available, no plugin needed). */
export const BUILTIN_PROPS: PropDefinition[] = [
  {
    id: "builtin:cube",
    name: "Cube",
    category: "builtin",
    modelUri: "", // no model — renderer draws a default cube
    defaultPhysics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
    defaultScale: 1.0,
    paintable: true,
  },
  {
    id: "builtin:sphere",
    name: "Sphere",
    category: "builtin",
    modelUri: "", // no model — renderer draws a default sphere
    defaultPhysics: { mass: 1.0, restitution: 0.6, friction: 0.3, gravityScale: 1.0 },
    defaultScale: 1.0,
    paintable: true,
  },
  {
    id: "builtin:mannequin",
    name: "Mannequin",
    category: "builtin",
    modelUri: "", // placeholder — renderer draws a simple capsule
    defaultPhysics: { mass: 5.0, restitution: 0.1, friction: 0.8, gravityScale: 1.0 },
    defaultScale: 1.0,
    paintable: true,
  },
];
