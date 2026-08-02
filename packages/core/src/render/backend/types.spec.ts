import { describe, it, expect } from "bun:test";
import {
  SHADER_STAGE_NONE,
  SHADER_STAGE_VERTEX,
  SHADER_STAGE_FRAGMENT,
  SHADER_STAGE_COMPUTE,
  BUFFER_USAGE_NONE,
  BUFFER_USAGE_MAP_READ,
  BUFFER_USAGE_MAP_WRITE,
  BUFFER_USAGE_COPY_SRC,
  BUFFER_USAGE_COPY_DST,
  BUFFER_USAGE_INDEX,
  BUFFER_USAGE_VERTEX,
  BUFFER_USAGE_UNIFORM,
  BUFFER_USAGE_STORAGE,
  BUFFER_USAGE_INDIRECT,
  BUFFER_USAGE_QUERY_RESOLVE,
  TEXTURE_USAGE_NONE,
  TEXTURE_USAGE_COPY_SRC,
  TEXTURE_USAGE_COPY_DST,
  TEXTURE_USAGE_TEXTURE_BINDING,
  TEXTURE_USAGE_STORAGE_BINDING,
  TEXTURE_USAGE_RENDER_ATTACHMENT,
  COLOR_WRITE_RED,
  COLOR_WRITE_GREEN,
  COLOR_WRITE_BLUE,
  COLOR_WRITE_ALPHA,
  COLOR_WRITE_ALL,
} from "./types.ts";

describe("types — shader stage flags", () => {
  it("has distinct bit flags", () => {
    expect(SHADER_STAGE_NONE).toBe(0);
    expect(SHADER_STAGE_VERTEX).toBe(1);
    expect(SHADER_STAGE_FRAGMENT).toBe(2);
    expect(SHADER_STAGE_COMPUTE).toBe(4);
  });

  it("can combine flags with bitwise OR", () => {
    const vertFrag = SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT;
    expect(vertFrag).toBe(3);
    expect(vertFrag & SHADER_STAGE_VERTEX).toBeTruthy();
    expect(vertFrag & SHADER_STAGE_FRAGMENT).toBeTruthy();
    expect(vertFrag & SHADER_STAGE_COMPUTE).toBeFalsy();
  });
});

describe("types — buffer usage flags", () => {
  it("has distinct power-of-2 flags", () => {
    expect(BUFFER_USAGE_NONE).toBe(0);
    expect(BUFFER_USAGE_MAP_READ).toBe(1);
    expect(BUFFER_USAGE_MAP_WRITE).toBe(2);
    expect(BUFFER_USAGE_COPY_SRC).toBe(4);
    expect(BUFFER_USAGE_COPY_DST).toBe(8);
    expect(BUFFER_USAGE_INDEX).toBe(16);
    expect(BUFFER_USAGE_VERTEX).toBe(32);
    expect(BUFFER_USAGE_UNIFORM).toBe(64);
    expect(BUFFER_USAGE_STORAGE).toBe(128);
    expect(BUFFER_USAGE_INDIRECT).toBe(256);
    expect(BUFFER_USAGE_QUERY_RESOLVE).toBe(512);
  });

  it("can combine usage flags", () => {
    const uniformCopy = BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST;
    expect(uniformCopy).toBe(72);
    expect(uniformCopy & BUFFER_USAGE_UNIFORM).toBeTruthy();
    expect(uniformCopy & BUFFER_USAGE_COPY_DST).toBeTruthy();
    expect(uniformCopy & BUFFER_USAGE_STORAGE).toBeFalsy();
  });
});

describe("types — texture usage flags", () => {
  it("has distinct power-of-2 flags", () => {
    expect(TEXTURE_USAGE_NONE).toBe(0);
    expect(TEXTURE_USAGE_COPY_SRC).toBe(1);
    expect(TEXTURE_USAGE_COPY_DST).toBe(2);
    expect(TEXTURE_USAGE_TEXTURE_BINDING).toBe(4);
    expect(TEXTURE_USAGE_STORAGE_BINDING).toBe(8);
    expect(TEXTURE_USAGE_RENDER_ATTACHMENT).toBe(16);
  });
});

describe("types — color write flags", () => {
  it("has correct individual flags", () => {
    expect(COLOR_WRITE_RED).toBe(1);
    expect(COLOR_WRITE_GREEN).toBe(2);
    expect(COLOR_WRITE_BLUE).toBe(4);
    expect(COLOR_WRITE_ALPHA).toBe(8);
  });

  it("COLOR_WRITE_ALL combines all channels", () => {
    expect(COLOR_WRITE_ALL).toBe(15);
    expect(COLOR_WRITE_ALL).toBe(
      COLOR_WRITE_RED | COLOR_WRITE_GREEN | COLOR_WRITE_BLUE | COLOR_WRITE_ALPHA,
    );
  });
});
