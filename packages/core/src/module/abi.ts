export const WASM_ABI_VERSION = 1;

export interface ABIVTable {
  getComponent: (entityIndex: number, componentId: number) => number;
  setComponent: (entityIndex: number, componentId: number, dataPtr: number) => void;
  allocateSAB: (name: string, size: number) => SharedArrayBuffer;
  registerSystem: (stage: number, callback: () => void) => void;
  subscribeEvent: (name: string, callback: () => void) => void;
}

export function createABIVTable(): ABIVTable {
  return {
    getComponent: (_entityIndex: number, _componentId: number) => 0,
    setComponent: (_entityIndex: number, _componentId: number, _dataPtr: number) => {},
    allocateSAB: (_name: string, size: number) => new SharedArrayBuffer(size),
    registerSystem: (_stage: number, _callback: () => void) => {},
    subscribeEvent: (_name: string, _callback: () => void) => {},
  };
}
