// ============================================================================
// Split-Screen Layout — viewport computation for 1-4 players
// ============================================================================

export type SplitscreenLayoutType =
  | "1p"
  | "2p-horizontal"
  | "2p-vertical"
  | "3p-top-wide"
  | "3p-bottom-wide"
  | "4p-corners";

export interface ViewportSlot {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeViewports(layout: SplitscreenLayoutType, screenW: number, screenH: number): ViewportSlot[] {
  switch (layout) {
    case "1p":
      return [{ index: 0, x: 0, y: 0, width: screenW, height: screenH }];

    case "2p-horizontal":
      return [
        { index: 0, x: 0, y: 0, width: screenW / 2, height: screenH },
        { index: 1, x: screenW / 2, y: 0, width: screenW / 2, height: screenH },
      ];

    case "2p-vertical":
      return [
        { index: 0, x: 0, y: 0, width: screenW, height: screenH / 2 },
        { index: 1, x: 0, y: screenH / 2, width: screenW, height: screenH / 2 },
      ];

    case "3p-top-wide":
      return [
        { index: 0, x: 0, y: 0, width: screenW, height: screenH / 2 },
        { index: 1, x: 0, y: screenH / 2, width: screenW / 2, height: screenH / 2 },
        { index: 2, x: screenW / 2, y: screenH / 2, width: screenW / 2, height: screenH / 2 },
      ];

    case "3p-bottom-wide":
      return [
        { index: 0, x: 0, y: 0, width: screenW / 2, height: screenH / 2 },
        { index: 1, x: screenW / 2, y: 0, width: screenW / 2, height: screenH / 2 },
        { index: 2, x: 0, y: screenH / 2, width: screenW, height: screenH / 2 },
      ];

    case "4p-corners":
      return [
        { index: 0, x: 0, y: 0, width: screenW / 2, height: screenH / 2 },
        { index: 1, x: screenW / 2, y: 0, width: screenW / 2, height: screenH / 2 },
        { index: 2, x: 0, y: screenH / 2, width: screenW / 2, height: screenH / 2 },
        { index: 3, x: screenW / 2, y: screenH / 2, width: screenW / 2, height: screenH / 2 },
      ];

    default:
      return [{ index: 0, x: 0, y: 0, width: screenW, height: screenH }];
  }
}

export function getLayoutForPlayerCount(count: number): SplitscreenLayoutType {
  switch (count) {
    case 1: return "1p";
    case 2: return "2p-horizontal";
    case 3: return "3p-top-wide";
    case 4: return "4p-corners";
    default: return "1p";
  }
}

export function getPlayerCountForLayout(layout: SplitscreenLayoutType): number {
  switch (layout) {
    case "1p": return 1;
    case "2p-horizontal":
    case "2p-vertical": return 2;
    case "3p-top-wide":
    case "3p-bottom-wide": return 3;
    case "4p-corners": return 4;
    default: return 1;
  }
}
