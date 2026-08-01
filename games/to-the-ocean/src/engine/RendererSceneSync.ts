// ============================================================================
// RendererSceneSync — syncs sim entities to scene store, manages gizmo state
// Extracted from WebGPURenderer for modularity
// ============================================================================

import { ENT, SimBufferReader } from "@shared/sim-buffer";
import { CameraMode, EntityType, EntityTypeNames } from "@shared/types";
import { useSceneStore } from "../stores/sceneStore";
import type { CameraSystem } from "./CameraSystem";
import type { TransformGizmo } from "@downdraft/plugin-devtools";
import type { CameraState } from "@downdraft/core";

export class RendererSceneSync {
  private simReader: SimBufferReader | null = null;
  private cameraSystem: CameraSystem | null = null;
  private transformGizmo: TransformGizmo | null = null;
  private gizmoDragging = false;
  private lastSceneSyncTime = 0;

  setSimReader(simReader: SimBufferReader): void {
    this.simReader = simReader;
  }

  setCameraSystem(cameraSystem: CameraSystem): void {
    this.cameraSystem = cameraSystem;
  }

  setTransformGizmo(gizmo: TransformGizmo): void {
    this.transformGizmo = gizmo;
  }

  syncSceneEntities(): void {
    if (!this.simReader || !this.simReader.isValid()) return;
    const entityCount = this.simReader.getEntityCount();
    const entities = [];
    for (let i = 0; i < entityCount; i++) {
      const entSlot = this.simReader.getEntitySlot(i);
      if (!entSlot) continue;
      const entId = entSlot.u32[ENT.ID];
      const type = entSlot.u32[ENT.TYPE] as EntityType;
      entities.push({
        id: entId,
        type,
        typeName: EntityTypeNames[type] ?? `Type${type}`,
        position: [entSlot.f32[ENT.POS_X], entSlot.f32[ENT.POS_Y], entSlot.f32[ENT.POS_Z]] as [number, number, number],
        rotation: [entSlot.f32[ENT.ROT_X], entSlot.f32[ENT.ROT_Y], entSlot.f32[ENT.ROT_Z], entSlot.f32[ENT.ROT_W]] as [number, number, number, number],
        scale: entSlot.f32[ENT.SCALE],
      });
    }
    useSceneStore.getState().syncSimEntities(entities);

    // Sync gizmo visibility and position from store state
    const storeState = useSceneStore.getState();
    if (this.transformGizmo) {
      const selectedNode = storeState.selectedId ? storeState.getNode(storeState.selectedId) : null;
      const shouldBeVisible = storeState.gizmoVisible && storeState.selectedId !== null && selectedNode !== null && !selectedNode.locked;
      if (shouldBeVisible !== this.transformGizmo.isVisible()) {
        this.transformGizmo.setVisible(shouldBeVisible);
      }
      const selectedId = storeState.selectedId;
      if (selectedId) {
        const node = storeState.getNode(selectedId);
        if (node) {
          this.transformGizmo.setPosition(node.position);
        }
      }
    }
  }

  maybeSync(throttleMs = 500): void {
    const now = performance.now();
    if (now - this.lastSceneSyncTime > throttleMs) {
      this.lastSceneSyncTime = now;
      this.syncSceneEntities();
    }
  }

  handleGizmoMouseDown(
    mouseX: number,
    mouseY: number,
    canvasW: number,
    canvasH: number,
  ): boolean {
    if (!this.transformGizmo || !this.transformGizmo.isVisible() || !this.cameraSystem) return false;
    if (!this.simReader || !this.simReader.isValid()) return false;

    const playerSlot = this.simReader.getPlayerSlot(0);
    if (!playerSlot) return false;

    const playerPos = {
      x: playerSlot.f32[ENT.POS_X],
      y: playerSlot.f32[ENT.POS_Y],
      z: playerSlot.f32[ENT.POS_Z],
    };
    const heading = playerSlot.f32[ENT.HEADING];
    const pitch = playerSlot.f32[ENT.PITCH] ?? 0;
    const cameraMode = playerSlot.u32[ENT.CAMERA_MODE] as CameraMode;
    const aspect = canvasW / canvasH;
    const camera = this.cameraSystem.calculateCamera(
      playerPos, heading, pitch, cameraMode, 0, 0, aspect,
    );

    const hit = this.transformGizmo.hitTest(mouseX, mouseY, canvasW, canvasH, camera);
    if (hit) {
      const selectedId = useSceneStore.getState().selectedId;
      if (!selectedId) return false;
      const node = useSceneStore.getState().getNode(selectedId);
      if (!node || node.locked) return false;
      this.transformGizmo.startDrag(hit, mouseX, mouseY, canvasW, canvasH, camera, {
        position: node.position,
        rotation: node.rotation,
        scale: node.scale,
      });
      this.gizmoDragging = true;
      return true;
    }
    return false;
  }

  handleGizmoMouseMove(
    mouseX: number,
    mouseY: number,
    canvasW: number,
    canvasH: number,
  ): void {
    if (!this.transformGizmo || !this.simReader || !this.simReader.isValid()) return;

    const playerSlot = this.simReader.getPlayerSlot(0);
    if (!playerSlot) return;

    const playerPos = {
      x: playerSlot.f32[ENT.POS_X],
      y: playerSlot.f32[ENT.POS_Y],
      z: playerSlot.f32[ENT.POS_Z],
    };
    const heading = playerSlot.f32[ENT.HEADING];
    const pitch = playerSlot.f32[ENT.PITCH] ?? 0;
    const cameraMode = playerSlot.u32[ENT.CAMERA_MODE] as CameraMode;
    const aspect = canvasW / canvasH;
    const camera = this.cameraSystem!.calculateCamera(
      playerPos, heading, pitch, cameraMode, 0, 0, aspect,
    );

    if (this.gizmoDragging) {
      this.transformGizmo.updateDrag(mouseX, mouseY, canvasW, canvasH, camera);
    }
  }

  handleGizmoMouseUp(): void {
    if (this.transformGizmo && this.gizmoDragging) {
      this.transformGizmo.endDrag();
      this.gizmoDragging = false;
    }
  }

  isGizmoDragging(): boolean {
    return this.gizmoDragging;
  }
}
