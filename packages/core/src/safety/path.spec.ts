import { confinePath, isPathSafe, sanitizeUri } from "./path";

describe("safety/path", () => {
  describe("confinePath", () => {
    it("allows relative paths within base dir", () => {
      const result = confinePath("/game/root", "scripts/foo.ts");
      expect(result).toBe("/game/root/scripts/foo.ts");
    });

    it("allows nested relative paths", () => {
      const result = confinePath("/game/root", "assets/textures/skin.png");
      expect(result).toBe("/game/root/assets/textures/skin.png");
    });

    it("rejects parent directory traversal", () => {
      expect(() => confinePath("/game/root", "../../etc/passwd")).toThrow("escapes base directory");
      expect(() => confinePath("/game/root", "../sibling")).toThrow("escapes base directory");
    });

    it("rejects absolute paths outside base", () => {
      expect(() => confinePath("/game/root", "/etc/passwd")).toThrow("escapes base directory");
      expect(() => confinePath("/game/root", "/home/other")).toThrow("escapes base directory");
    });

    it("allows absolute paths equal to base", () => {
      const result = confinePath("/game/root", "/game/root");
      expect(result).toBe("/game/root");
    });

    it("allows absolute paths within base", () => {
      const result = confinePath("/game/root", "/game/root/scripts/foo.ts");
      expect(result).toBe("/game/root/scripts/foo.ts");
    });

    it("rejects traversal via intermediate ..", () => {
      expect(() => confinePath("/game/root", "scripts/../../etc")).toThrow("escapes base directory");
    });

    it("handles trailing slashes in base dir", () => {
      const result = confinePath("/game/root/", "scripts/foo.ts");
      expect(result).toBe("/game/root/scripts/foo.ts");
    });
  });

  describe("isPathSafe", () => {
    it("returns true for safe paths", () => {
      expect(isPathSafe("/game/root", "scripts/foo.ts")).toBe(true);
    });

    it("returns false for traversal paths", () => {
      expect(isPathSafe("/game/root", "../../etc/passwd")).toBe(false);
    });

    it("returns false for absolute paths outside base", () => {
      expect(isPathSafe("/game/root", "/etc/passwd")).toBe(false);
    });
  });

  describe("sanitizeUri", () => {
    it("allows data URIs", () => {
      expect(sanitizeUri("data:image/png;base64,abc123")).toBe("data:image/png;base64,abc123");
    });

    it("allows relative paths without ..", () => {
      expect(sanitizeUri("textures/skin.png")).toBe("textures/skin.png");
    });

    it("rejects file:// URIs", () => {
      expect(() => sanitizeUri("file:///etc/passwd")).toThrow("file://");
    });

    it("rejects http:// URIs by default", () => {
      expect(() => sanitizeUri("http://evil.com/script.js")).toThrow("Remote URIs");
    });

    it("allows http:// URIs when allowRemote is true", () => {
      expect(sanitizeUri("http://example.com/texture.png", { allowRemote: true })).toBe(
        "http://example.com/texture.png",
      );
    });

    it("rejects paths with ..", () => {
      expect(() => sanitizeUri("../../etc/passwd")).toThrow("Path traversal");
    });

    it("rejects absolute paths", () => {
      expect(() => sanitizeUri("/etc/passwd")).toThrow("Absolute paths");
    });

    it("validates against baseDir when provided", () => {
      expect(sanitizeUri("textures/skin.png", { baseDir: "/game/root" })).toBe(
        "/game/root/textures/skin.png",
      );
      expect(() => sanitizeUri("../escape", { baseDir: "/game/root" })).toThrow("Path traversal");
    });
  });
});
