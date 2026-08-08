import { confinePath } from "@downdraft/core";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { scaffold, type ScaffoldOptions } from "./scaffold";

const baseOpts: ScaffoldOptions = {
  template: "minimal",
  name: "test-game",
  description: "test",
  author: "test",
  version: "0.0.1",
  aiCompanion: false,
  force: true,
};

describe("scaffold path traversal", () => {
  let origCwd: string;
  let tempRoot: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "scaffold-spec-"));
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("accepts normal relative target paths", async () => {
    const target = "my-game";
    await scaffold(target, { ...baseOpts, force: true });
    // The scaffold should have created the target directory within the cwd.
    expect(existsSync(join(tempRoot, target))).toBe(true);
  });

  it("rejects parent directory traversal in target path", async () => {
    await expect(scaffold("../../etc/passwd", baseOpts)).rejects.toThrow("escapes base directory");
  });

  it("rejects absolute paths outside the project", async () => {
    await expect(scaffold("/etc/passwd", baseOpts)).rejects.toThrow("escapes base directory");
  });

  it("rejects parent directory traversal in template name", async () => {
    await expect(
      scaffold("my-game", { ...baseOpts, template: "../../etc/passwd" }),
    ).rejects.toThrow("escapes base directory");
  });
});

describe("scaffold path traversal (confinePath direct)", () => {
  it("allows relative paths within base dir", () => {
    expect(() => confinePath(process.cwd(), "my-game")).not.toThrow();
  });

  it("rejects ../../etc/passwd", () => {
    expect(() => confinePath(process.cwd(), "../../etc/passwd")).toThrow("escapes base directory");
  });

  it("rejects absolute paths outside the project", () => {
    expect(() => confinePath(process.cwd(), "/etc/passwd")).toThrow("escapes base directory");
  });
});
