// ============================================================================
// SceneSync — syncs entities to scene store, manages gizmo state
// Generic gizmo interaction logic; game provides data via ISceneSyncProvider.
// ============================================================================

import type { TransformGizmo } from "./transform-gizmo";
import { useSceneStore } from "./scene-store";
import type { ISceneSyncProvider } from "./types";

export class SceneSync {
  private provider: ISceneSyncProvider | null = null;
  private transformGizmo: TransformGizmo | null = null;
  private gizmoDragging = false;
  private lastSceneSyncTime = 0;

  setProvider(provider: ISceneSyncProvider): void {
    this.provider = provider;
  }

  setTransformGizmo(gizmo: TransformGizmo): void {
    this.transformGizmo = gizmo;
  }

  syncSceneEntities(): void {
    if (!this.provider) return;
    const entities = this.provider.getEntitySnapshots();
    useSceneStore.getState().syncSimEntities(entities);

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
    calculateCamera: (pos: { x: number; y: number; z: number }, heading: number, pitch: number, cameraMode: number, mx: number, my: number, aspect: number) => any,
  ): boolean {
    if (!this.transformGizmo || !this.transformGizmo.isVisible() || !this.provider) return false;

    const playerCam = this.provider.getPlayerCamera();
    if (!playerCam) return false;

    const aspect = canvasW / canvasH;
    const camera = calculateCamera(playerCam.position, playerCam.heading, playerCam.pitch, playerCam.cameraMode, 0, 0, aspect);

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
    calculateCamera: (pos: { x: number; y: number; z: number }, heading: number, pitch: number, cameraMode: number, mx: number, my: number, aspect: number) => any,
  ): void {
    if (!this.transformGizmo || !this.provider) return;

    const playerCam = this.provider.getPlayerCamera();
    if (!playerCam) return;

    const aspect = canvasW / canvasH;
    const camera = calculateCamera(playerCam.position, playerCam.heading, playerCam.pitch, playerCam.cameraMode, 0, 0, aspect);

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
