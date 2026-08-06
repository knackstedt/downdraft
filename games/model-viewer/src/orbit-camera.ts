import type { CameraState } from "@downdraft/core";

export class OrbitCamera {
  private azimuth = Math.PI * 0.25;
  private elevation = Math.PI * 0.2;
  private distance = 5;
  private target: [number, number, number] = [0, 0, 0];
  private fov = 45; // degrees — calculateViewProj converts to radians internally
  private near = 1.0;
  private far = 500;

  private isDragging = false;
  private lastX = 0;
  private lastY = 0;

  private rotateSpeed = 0.005;
  private zoomSpeed = 0.1;
  private panSpeed = 0.002;

  private aspect = 1;

  constructor(canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  destroy(canvas: HTMLCanvasElement) {
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerUp);
    canvas.removeEventListener("wheel", this.onWheel);
  }

  setAspect(w: number, h: number) {
    this.aspect = w / h;
  }

  frameBounds(min: [number, number, number], max: [number, number, number]) {
    const oldDist = this.distance;
    const oldPos = this.getCameraState().position;

    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 0.1);
    // Render loop scales model so largest dimension = 2.0 (scaleFactor = 2.0 / size)
    // After scaling, largest half-extent = 1.0. Bounding sphere radius = sqrt(3) max.
    const hx = (max[0] - min[0]) / size;
    const hy = (max[1] - min[1]) / size;
    const hz = (max[2] - min[2]) / size;
    const radius = Math.sqrt(hx * hx + hy * hy + hz * hz);
    // FOV is in degrees, convert to radians for trig
    const fovRad = this.fov * Math.PI / 180;
    const horizFovRad = 2 * Math.atan(Math.tan(fovRad / 2) * this.aspect);
    const effectiveFovRad = Math.min(fovRad, horizFovRad);
    this.distance = (radius / Math.sin(effectiveFovRad / 2)) * 1.3;
    this.target = [0, 0, 0];
    this.elevation = Math.PI * 0.15;
    this.azimuth = Math.PI * 0.25;

    // const newPos = this.getCameraState().position;
    // console.log(`[OrbitCamera] frameBounds DEBUG:`);
    // console.log(`  bounds: min=[${min.map(v => v.toFixed(3))}] max=[${max.map(v => v.toFixed(3))}]`);
    // console.log(`  size=${size.toFixed(4)}, hx=${hx.toFixed(4)}, hy=${hy.toFixed(4)}, hz=${hz.toFixed(4)}`);
    // console.log(`  radius=${radius.toFixed(4)}, fov=${this.fov}deg, effectiveFov=${(effectiveFovRad * 180 / Math.PI).toFixed(2)}deg`);
    // console.log(`  sin(effFov/2)=${Math.sin(effectiveFovRad / 2).toFixed(6)}`);
    // console.log(`  distance: ${oldDist.toFixed(4)} -> ${this.distance.toFixed(4)}`);
    // console.log(`  position: [${oldPos.map(v => v.toFixed(4))}] -> [${newPos.map(v => v.toFixed(4))}]`);
    // console.log(`  elevation=${this.elevation.toFixed(4)}, azimuth=${this.azimuth.toFixed(4)}, aspect=${this.aspect.toFixed(4)}`);
  }

  getCameraState(): CameraState {
    const cosEl = Math.cos(this.elevation);
    const x = this.target[0] + this.distance * cosEl * Math.cos(this.azimuth);
    const y = this.target[1] + this.distance * Math.sin(this.elevation);
    const z = this.target[2] + this.distance * cosEl * Math.sin(this.azimuth);
    // const pos: [number, number, number] = [x, y, z];
    // if ((this as any)._debugLog) {
    //   console.log(`[OrbitCamera] getCameraState: pos=[${pos.map(v => v.toFixed(4))}], target=[${this.target.map(v => v.toFixed(4))}], dist=${this.distance.toFixed(4)}, near=${this.near}, far=${this.far}`);
    // }
    return {
      position: [x, y, z],
      target: [...this.target] as [number, number, number],
      up: [0, 1, 0],
      fov: this.fov,
      near: this.near,
      far: this.far,
      aspect: this.aspect,
    };
  }

  private onPointerDown = (e: PointerEvent) => {
    this.isDragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.isDragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (e.button === 2 || e.shiftKey) {
      // Pan
      const panX = -dx * this.panSpeed * this.distance;
      const panY = dy * this.panSpeed * this.distance;
      const cosEl = Math.cos(this.elevation);
      const right: [number, number, number] = [
        Math.cos(this.azimuth + Math.PI / 2),
        0,
        Math.sin(this.azimuth + Math.PI / 2),
      ];
      const up: [number, number, number] = [
        -Math.sin(this.elevation) * Math.cos(this.azimuth),
        Math.cos(this.elevation),
        -Math.sin(this.elevation) * Math.sin(this.azimuth),
      ];
      this.target[0] += right[0] * panX + up[0] * panY;
      this.target[1] += right[1] * panX + up[1] * panY;
      this.target[2] += right[2] * panX + up[2] * panY;
    } else {
      // Rotate
      this.azimuth -= dx * this.rotateSpeed;
      this.elevation += dy * this.rotateSpeed;
      this.elevation = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49, this.elevation));
    }
  };

  private onPointerUp = () => {
    this.isDragging = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const oldDist = this.distance;
    this.distance *= 1 + e.deltaY * this.zoomSpeed * 0.01;
    this.distance = Math.max(this.near * 1.5, Math.min(this.far * 0.9, this.distance));
    const pos = this.getCameraState().position;
    // console.log(`[OrbitCamera] wheel: deltaY=${e.deltaY}, dist: ${oldDist.toFixed(4)} -> ${this.distance.toFixed(4)}, pos=[${pos.map(v => v.toFixed(4))}]`);
  };
}
