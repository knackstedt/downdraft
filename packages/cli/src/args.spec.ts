import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ArgError, formatFlag, parseArgs, renderHelp, type CommandSchema } from "./args";

// Capture stderr writes emitted by the parser for unknown-flag warnings.
let stderrBuf: string[] = [];
const origWrite = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  stderrBuf = [];
  process.stderr.write = ((chunk: string) => {
    stderrBuf.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = origWrite;
  delete process.env.DOWNDRAFT_STRICT;
});

describe("parseArgs — boolean flags", () => {
  it("sets boolean flags to true when present", () => {
    const schema: CommandSchema = {
      flags: [{ name: "verbose", alias: "v", type: "boolean" }],
    };
    const r = parseArgs(["--verbose"], schema);
    expect(r.flags.verbose).toBe(true);
    expect(r.help).toBe(false);
  });

  it("defaults boolean flags to false when absent", () => {
    const schema: CommandSchema = {
      flags: [{ name: "verbose", type: "boolean" }],
    };
    const r = parseArgs([], schema);
    expect(r.flags.verbose).toBe(false);
  });

  it("accepts short aliases", () => {
    const schema: CommandSchema = {
      flags: [{ name: "verbose", alias: "v", type: "boolean" }],
    };
    expect(parseArgs(["-v"], schema).flags.verbose).toBe(true);
  });

  it("rejects a value attached to a boolean flag (--flag=value)", () => {
    const schema: CommandSchema = {
      flags: [{ name: "force", type: "boolean" }],
    };
    expect(() => parseArgs(["--force=yes"], schema)).toThrow(ArgError);
  });
});

describe("parseArgs — string flags", () => {
  it("parses --flag=value", () => {
    const schema: CommandSchema = {
      flags: [{ name: "game", type: "string" }],
    };
    expect(parseArgs(["--game=foo"], schema).flags.game).toBe("foo");
  });

  it("parses --flag value (space form)", () => {
    const schema: CommandSchema = {
      flags: [{ name: "game", type: "string" }],
    };
    expect(parseArgs(["--game", "foo"], schema).flags.game).toBe("foo");
  });

  it("parses short alias -g value", () => {
    const schema: CommandSchema = {
      flags: [{ name: "game", alias: "g", type: "string" }],
    };
    expect(parseArgs(["-g", "foo"], schema).flags.game).toBe("foo");
  });

  it("parses short alias -gvalue (attached)", () => {
    const schema: CommandSchema = {
      flags: [{ name: "game", alias: "g", type: "string" }],
    };
    expect(parseArgs(["-gfoo"], schema).flags.game).toBe("foo");
  });

  it("parses short alias -g=value", () => {
    const schema: CommandSchema = {
      flags: [{ name: "game", alias: "g", type: "string" }],
    };
    expect(parseArgs(["-g=foo"], schema).flags.game).toBe("foo");
  });

  it("throws when a string flag has no value", () => {
    const schema: CommandSchema = {
      flags: [{ name: "game", type: "string" }],
    };
    expect(() => parseArgs(["--game"], schema)).toThrow(ArgError);
  });

  it("applies a default when absent", () => {
    const schema: CommandSchema = {
      flags: [{ name: "mode", type: "string", default: "prod" }],
    };
    expect(parseArgs([], schema).flags.mode).toBe("prod");
  });
});

describe("parseArgs — number flags", () => {
  it("parses numeric values", () => {
    const schema: CommandSchema = {
      flags: [{ name: "port", type: "number" }],
    };
    expect(parseArgs(["--port", "9976"], schema).flags.port).toBe(9976);
  });

  it("rejects non-numeric values", () => {
    const schema: CommandSchema = {
      flags: [{ name: "port", type: "number" }],
    };
    expect(() => parseArgs(["--port", "abc"], schema)).toThrow(ArgError);
  });
});

describe("parseArgs — enum validation", () => {
  it("accepts a value in the enum", () => {
    const schema: CommandSchema = {
      flags: [{ name: "target", type: "string", enum: ["win", "linux", "mac", "all"] }],
    };
    expect(parseArgs(["--target=win"], schema).flags.target).toBe("win");
  });

  it("rejects a value not in the enum", () => {
    const schema: CommandSchema = {
      flags: [{ name: "target", type: "string", enum: ["win", "linux", "mac", "all"] }],
    };
    expect(() => parseArgs(["--target=windows"], schema)).toThrow(ArgError);
  });
});

describe("parseArgs — repeatable flags", () => {
  it("collects repeated occurrences into an array", () => {
    const schema: CommandSchema = {
      flags: [{ name: "game", type: "string", repeatable: true }],
    };
    const r = parseArgs(["--game", "a", "--game", "b"], schema);
    expect(r.flags.game).toEqual(["a", "b"]);
  });

  it("defaults to an empty array", () => {
    const schema: CommandSchema = {
      flags: [{ name: "game", type: "string", repeatable: true }],
    };
    expect(parseArgs([], schema).flags.game).toEqual([]);
  });
});

describe("parseArgs — required flags", () => {
  it("throws when a required flag is missing", () => {
    const schema: CommandSchema = {
      flags: [{ name: "games", type: "string", required: true }],
    };
    expect(() => parseArgs([], schema)).toThrow(ArgError);
  });

  it("passes when a required flag is present", () => {
    const schema: CommandSchema = {
      flags: [{ name: "games", type: "string", required: true }],
    };
    expect(parseArgs(["--games=x"], schema).flags.games).toBe("x");
  });
});

describe("parseArgs — positionals", () => {
  it("collects non-flag args as positionals", () => {
    const schema: CommandSchema = {
      positionals: [{ name: "path" }, { name: "name" }],
    };
    const r = parseArgs(["foo", "bar"], schema);
    expect(r.positionals).toEqual(["foo", "bar"]);
  });

  it("throws on a missing required positional", () => {
    const schema: CommandSchema = {
      positionals: [{ name: "path", required: true }],
    };
    expect(() => parseArgs([], schema)).toThrow(ArgError);
  });

  it("absorbs the rest into a variadic positional", () => {
    const schema: CommandSchema = {
      positionals: [{ name: "rest", variadic: true }],
    };
    expect(parseArgs(["a", "b", "c"], schema).positionals).toEqual(["a", "b", "c"]);
  });

  it("warns on extra undeclared positionals (non-strict)", () => {
    const schema: CommandSchema = {
      positionals: [{ name: "path" }],
    };
    const r = parseArgs(["a", "b"], schema);
    expect(r.positionals).toEqual(["a", "b"]);
    expect(stderrBuf.join("")).toContain("Unexpected positional");
  });

  it("hard-errors on extra positionals in strict mode", () => {
    process.env.DOWNDRAFT_STRICT = "1";
    const schema: CommandSchema = {
      positionals: [{ name: "path" }],
    };
    expect(() => parseArgs(["a", "b"], schema)).toThrow(ArgError);
  });
});

describe("parseArgs -- terminator", () => {
  it("treats everything after -- as positional", () => {
    const schema: CommandSchema = {
      flags: [{ name: "game", type: "string" }],
      positionals: [{ name: "rest", variadic: true }],
    };
    const r = parseArgs(["--game=x", "--", "--foo", "bar"], schema);
    expect(r.flags.game).toBe("x");
    expect(r.positionals).toEqual(["--foo", "bar"]);
  });
});

describe("parseArgs — unknown flags", () => {
  it("warns on unknown long flags (non-strict)", () => {
    const schema: CommandSchema = { flags: [] };
    parseArgs(["--nope"], schema);
    expect(stderrBuf.join("")).toContain("Unknown flag: --nope");
  });

  it("warns on unknown short flags (non-strict)", () => {
    const schema: CommandSchema = { flags: [] };
    parseArgs(["-z"], schema);
    expect(stderrBuf.join("")).toContain("Unknown flag: -z");
  });

  it("hard-errors on unknown flags in strict mode", () => {
    process.env.DOWNDRAFT_STRICT = "1";
    const schema: CommandSchema = { flags: [] };
    expect(() => parseArgs(["--nope"], schema)).toThrow(ArgError);
  });
});

describe("parseArgs — --help", () => {
  it("returns help=true for --help", () => {
    const schema: CommandSchema = { flags: [{ name: "game", type: "string" }] };
    expect(parseArgs(["--help"], schema).help).toBe(true);
  });

  it("returns help=true for -h", () => {
    const schema: CommandSchema = { flags: [{ name: "game", type: "string" }] };
    expect(parseArgs(["-h"], schema).help).toBe(true);
  });

  it("skips validation when help is requested", () => {
    const schema: CommandSchema = {
      flags: [{ name: "games", type: "string", required: true }],
    };
    // Required flag missing, but --help present → no throw.
    expect(parseArgs(["--help"], schema).help).toBe(true);
  });
});

describe("formatFlag", () => {
  it("renders a string flag with placeholder", () => {
    expect(formatFlag({ name: "game", type: "string" })).toBe("--game <game>");
  });

  it("renders an aliased string flag", () => {
    expect(formatFlag({ name: "game", alias: "g", type: "string" })).toBe("--game <game>, -g <game>");
  });

  it("renders a boolean flag without placeholder", () => {
    expect(formatFlag({ name: "force", type: "boolean" })).toBe("--force");
  });
});

describe("renderHelp", () => {
  it("includes the usage line and flags", () => {
    const help = renderHelp("draft test [options]", {
      flags: [
        { name: "game", alias: "g", type: "string", description: "Game to test" },
        { name: "renderer", alias: "r", type: "string", enum: ["gpu", "cpu"], default: "cpu", description: "WebGPU backend" },
      ],
    });
    expect(help).toContain("Usage: draft test [options]");
    expect(help).toContain("--game <game>, -g <game>");
    expect(help).toContain("Game to test");
    expect(help).toContain("one of: gpu|cpu");
    expect(help).toContain("-h, --help");
  });

  it("includes positionals when declared", () => {
    const help = renderHelp("draft new [path]", {
      positionals: [{ name: "path", description: "Target directory" }],
    });
    expect(help).toContain("Arguments:");
    expect(help).toContain("<path>");
    expect(help).toContain("Target directory");
  });
});
