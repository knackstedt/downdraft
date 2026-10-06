// ============================================================================
// @downdraft/engine/libraries/inspectable — schema'd registry of named
// game-state nodes that automation can read and write semantically
// (no synthetic input). See inspectable.ts for the design notes.
// ============================================================================

export {
    InspectableError, InspectableRegistry,
    type InspectableNode, type InspectableNodeInfo, type InspectableSetResult,
    type InspectableThread, type InspectableType
} from "./inspectable";
