import { XRCameraRig } from "./camera-rig.ts";
import { XRLayerManager } from "./layer.ts";
import type { XRWorldOrigin } from "./types.ts";

describe("XRCameraRig", () => {
  const identityOrigin: XRWorldOrigin = {
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
  };

  it("should return null cameras when no layer views are available", () => {
    const layerMgr = new XRLayerManager();
    const rig = new XRCameraRig(layerMgr, () => identityOrigin);
    const [left, right] = rig.computeEyeCameras(1920, 1080);
    expect(left).toBeNull();
    expect(right).toBeNull();
  });

  it("should start with identity head pose", () => {
    const layerMgr = new XRLayerManager();
    const rig = new XRCameraRig(layerMgr, () => identityOrigin);
    const pose = rig.getHeadPose();
    expect(pose.position).toEqual([0, 0, 0]);
    expect(pose.quaternion).toEqual([0, 0, 0, 1]);
  });

  it("should apply world origin offset to head pose", () => {
    const layerMgr = new XRLayerManager();
    const offsetOrigin: XRWorldOrigin = {
      position: [10, 5, -3],
      quaternion: [0, 0, 0, 1],
    };
    const rig = new XRCameraRig(layerMgr, () => offsetOrigin);

    // Create a mock viewer pose with identity transform
    const mockPose = {
      transform: {
        matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.7, 0, 1]),
      },
    } as unknown as XRViewerPose;

    const mockRefSpace = {} as XRReferenceSpace;
    rig.updateHeadPose(mockPose, mockRefSpace);

    const pose = rig.getHeadPose();
    // World origin is at [10, 5, -3], head is at [0, 1.7, 0] in local space
    // So world position should be [10, 6.7, -3]
    expect(pose.position[0]).toBeCloseTo(10);
    expect(pose.position[1]).toBeCloseTo(6.7);
    expect(pose.position[2]).toBeCloseTo(-3);
  });
});
