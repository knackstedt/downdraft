// Renderer-side fs shim — uses fetch for reading since require("fs") is not
// available with contextIsolation + sandbox enabled.

async function readFile(path: string, encoding?: string): Promise<string | Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to read ${path}: ${response.status}`);
  if (encoding) {
    return await response.text();
  }
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

export const existsSync = (_path: string): boolean => {
  return false;
};

export const promises = {
  readFile,
  writeFile: async (_path: string, _data: string | Uint8Array): Promise<void> => {
    throw new Error("fs.writeFile is not available in sandboxed renderer");
  },
};

export function watch(_path: string): { close(): void } {
  return { close() {} };
}

export default { existsSync, promises, watch };
