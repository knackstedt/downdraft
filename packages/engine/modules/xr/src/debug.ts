import { isXRAvailable, isXRGPUBindingAvailable, isVRSupported } from "./session";
import type { XRModule } from "./xr-module";

export interface XRDebugInfo {
  xrAvailable: boolean;
  xrGPUBindingAvailable: boolean;
  vrSupported: boolean;
  sessionState: string;
  active: boolean;
  controllerCount: number;
  headPosition: [number, number, number];
  headQuaternion: [number, number, number, number];
}

export function getXRDebugInfo(plugin: XRModule): XRDebugInfo {
  return {
    xrAvailable: isXRAvailable(),
    xrGPUBindingAvailable: isXRGPUBindingAvailable(),
    vrSupported: false,
    sessionState: plugin.getSessionManager().getState(),
    active: plugin.isActive(),
    controllerCount: plugin.getInputMapper().getControllerCount(),
    headPosition: plugin.getHeadPose().position,
    headQuaternion: plugin.getHeadPose().quaternion,
  };
}

export async function checkXRSupport(): Promise<{ available: boolean; vrSupported: boolean; gpuBinding: boolean; message: string }> {
  const available = isXRAvailable();
  const gpuBinding = isXRGPUBindingAvailable();
  const vrSupported = available ? await isVRSupported() : false;

  let message: string;
  if (!available) {
    message = "WebXR API not available. Use a WebXR-compatible browser (Chrome/Edge with WebXR support).";
  } else if (!gpuBinding) {
    message = "XRGPUBinding not available. Enable chrome://flags/#webxr-incubations for WebGPU-native XR rendering.";
  } else if (!vrSupported) {
    message = "Immersive VR not supported. Connect a VR headset or use a WebXR emulator.";
  } else {
    message = "WebXR VR is ready.";
  }

  return { available, vrSupported, gpuBinding, message };
}

export function formatXRDebugInfo(info: XRDebugInfo): string {
  const lines = [
    `XR Available: ${info.xrAvailable ? "YES" : "NO"}`,
    `XRGPU Binding: ${info.xrGPUBindingAvailable ? "YES" : "NO"}`,
    `VR Supported: ${info.vrSupported ? "YES" : "NO"}`,
    `Session State: ${info.sessionState}`,
    `Active: ${info.active ? "YES" : "NO"}`,
    `Controllers: ${info.controllerCount}`,
    `Head Pos: [${info.headPosition[0].toFixed(3)}, ${info.headPosition[1].toFixed(3)}, ${info.headPosition[2].toFixed(3)}]`,
    `Head Quat: [${info.headQuaternion[0].toFixed(3)}, ${info.headQuaternion[1].toFixed(3)}, ${info.headQuaternion[2].toFixed(3)}, ${info.headQuaternion[3].toFixed(3)}]`,
  ];
  return lines.join("\n");
}
