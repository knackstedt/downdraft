// ============================================================================
// args.ts — shared CLI argument parser
// ============================================================================
//
// A dependency-free parser shared by every `draft` subcommand. Replaces the
// per-command hand-rolled argv loops with a single, consistent, validated
// surface:
//
//   - Supports `--flag`, `--flag=value`, `--flag value`, `-x`, `-x value`.
//   - Boolean flags, string flags, number flags, repeatable flags.
//   - Enum validation, required-flag validation.
//   - Unknown flags warn (hard-error when DOWNDRAFT_STRICT=1).
//   - Built-in `--help` / `-h` (caller prints usage + exits 0).
//
// Each subcommand declares a `CommandSchema` and calls `parseArgs()`. The
// parser is pure (no I/O) so it is trivially unit-testable.
//

/** A single flag declaration. */
export interface FlagSpec {
  /** Long name without `--` (e.g. `"game"`). */
  name: string;
  /** Optional single-char alias without `-` (e.g. `"g"`). */
  alias?: string;
  type: "string" | "boolean" | "number";
  /** Default value when the flag is absent. Repeatable flags default to `[]`. */
  default?: string | boolean | number | string[];
  /** Allowed values for `string` / `number` flags. */
  enum?: string[];
  /** Hard-error if absent. */
  required?: boolean;
  /** Collect repeated occurrences into `string[]`. Implies `type: "string"`. */
  repeatable?: boolean;
  /** One-line description for `--help` output. */
  description?: string;
}

/** A single positional declaration. */
export interface PositionalSpec {
  name: string;
  required?: boolean;
  /** Collect all remaining positionals into `string[]`. Must be last. */
  variadic?: boolean;
  description?: string;
}

/** Schema describing a command's accepted flags + positionals. */
export interface CommandSchema {
  flags?: FlagSpec[];
  positionals?: PositionalSpec[];
}

/** Result of a successful parse. */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | number | string[]>;
  /** True if `--help` / `-h` was present. Caller should print usage + exit 0. */
  help: boolean;
}

/** Thrown on a hard parse error (missing required, bad enum, bad number). */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

/** Write help/version text to stdout (bypasses the logger, which may
 *  redirect to stderr in MCP mode). */
export function print(text: string): void {
  process.stdout.write(text + "\n");
}

/** Whether STRICT diagnostics are active (unknown flags → hard error). */
function isStrict(): boolean {
  const v = process.env.DOWNDRAFT_STRICT;
  if (v !== undefined) return v === "1";
  return false; // parser default; dev-mode strictness is opt-in here
}

/** Format a flag spec for usage output, e.g. `--game <name>, -g <name>`. */
export function formatFlag(spec: FlagSpec): string {
  const placeholder = spec.type === "boolean" ? "" : ` <${spec.name}>`;
  const long = `--${spec.name}${placeholder}`;
  if (spec.alias) {
    const short = `-${spec.alias}${placeholder}`;
    return `${long}, ${short}`;
  }
  return long;
}

/**
 * Parse `argv` (the slice AFTER the subcommand name) against `schema`.
 *
 * Throws `ArgError` on validation failures. Returns `{ help: true }` when
 * `--help` / `-h` is present (no validation runs in that case).
 */
export function parseArgs(argv: string[], schema: CommandSchema): ParsedArgs {
  const flags = schema.flags ?? [];
  const positionals = schema.positionals ?? [];

  // Build lookup maps.
  const byLong = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const f of flags) {
    byLong.set(f.name, f);
    if (f.alias) byShort.set(f.alias, f);
  }

  // Initialize defaults.
  const out: Record<string, string | boolean | number | string[]> = {};
  for (const f of flags) {
    if (f.repeatable) {
      out[f.name] = f.default ? [...(f.default as string[])] : [];
    } else if (f.default !== undefined) {
      out[f.name] = f.default;
    } else if (f.type === "boolean") {
      out[f.name] = false;
    } else {
      out[f.name] = "";
    }
  }

  const posValues: string[] = [];
  let help = false;
  const strict = isStrict();

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i++];

    // `--` terminates flag parsing; remaining args are positionals.
    if (arg === "--") {
      while (i < argv.length) posValues.push(argv[i++]);
      break;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    // Long flag: --name or --name=value
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const inline = eq === -1 ? undefined : body.slice(eq + 1);

      const spec = byLong.get(name);
      if (!spec) {
        const msg = `Unknown flag: --${name}`;
        if (strict) throw new ArgError(msg);
        process.stderr.write(`warn: ${msg}\n`);
        continue;
      }

      if (spec.type === "boolean") {
        if (inline !== undefined) {
          throw new ArgError(`--${name} does not take a value (got "${inline}")`);
        }
        out[spec.name] = true;
      } else {
        const value = inline !== undefined ? inline : consumeValue(argv, i, spec.name);
        if (inline === undefined) i++; // consumed the next arg
        assignFlag(out, spec, value);
      }
      continue;
    }

    // Short flag: -x or -xvalue or -x value
    if (arg.startsWith("-") && arg.length > 1 && arg !== "-") {
      const body = arg.slice(1);
      // Support `-x=value` and `-xvalue` (attached) and `-x value` (separate).
      let alias: string;
      let inline: string | undefined;
      if (body.length > 1) {
        alias = body[0];
        const rest = body.slice(1);
        inline = rest.startsWith("=") ? rest.slice(1) : rest;
      } else {
        alias = body;
        inline = undefined;
      }

      const spec = byShort.get(alias);
      if (!spec) {
        const msg = `Unknown flag: -${alias}`;
        if (strict) throw new ArgError(msg);
        process.stderr.write(`warn: ${msg}\n`);
        continue;
      }

      if (spec.type === "boolean") {
        if (inline !== undefined) {
          throw new ArgError(`-${alias} does not take a value (got "${inline}")`);
        }
        out[spec.name] = true;
      } else {
        const value = inline !== undefined ? inline : consumeValue(argv, i, spec.name);
        if (inline === undefined) i++;
        assignFlag(out, spec, value);
      }
      continue;
    }

    // Positional.
    posValues.push(arg);
  }

  if (help) return { positionals: posValues, flags: out, help: true };

  // Validate required flags.
  for (const f of flags) {
    if (!f.required) continue;
    const v = out[f.name];
    const missing =
      v === "" ||
      v === false ||
      (Array.isArray(v) && v.length === 0);
    if (missing) {
      throw new ArgError(`Missing required flag: --${f.name}`);
    }
  }

  // Validate positionals.
  let pi = 0;
  for (const p of positionals) {
    if (p.variadic) {
      // Variadic absorbs the rest; required means at least one.
      if (p.required && posValues.slice(pi).length === 0) {
        throw new ArgError(`Missing required positional: <${p.name}>`);
      }
      pi = posValues.length;
      break;
    }
    if (pi >= posValues.length) {
      if (p.required) {
        throw new ArgError(`Missing required positional: <${p.name}>`);
      }
      break;
    }
    pi++;
  }
  // Extra positionals not declared → warn (or error in strict).
  const declared = positionals.reduce(
    (n, p) => n + (p.variadic ? Infinity : 1),
    0,
  );
  if (posValues.length > declared && declared !== Infinity) {
    const msg = `Unexpected positional argument: ${posValues[declared]}`;
    if (strict) throw new ArgError(msg);
    process.stderr.write(`warn: ${msg}\n`);
  }

  return { positionals: posValues, flags: out, help: false };
}

/** Read the next argv token as a flag value, throwing if absent. */
function consumeValue(argv: string[], i: number, name: string): string {
  if (i >= argv.length) {
    throw new ArgError(`Flag --${name} requires a value`);
  }
  return argv[i];
}

/** Assign a parsed string value to `out` with type/enum/repeatable handling. */
function assignFlag(
  out: Record<string, string | boolean | number | string[]>,
  spec: FlagSpec,
  raw: string,
): void {
  if (spec.repeatable) {
    (out[spec.name] as string[]).push(raw);
    return;
  }
  if (spec.type === "number") {
    const n = Number(raw);
    if (raw === "" || Number.isNaN(n)) {
      throw new ArgError(`--${spec.name} expects a number (got "${raw}")`);
    }
    out[spec.name] = n;
    return;
  }
  if (spec.enum && !spec.enum.includes(raw)) {
    throw new ArgError(
      `--${spec.name} must be one of: ${spec.enum.join(", ")} (got "${raw}")`,
    );
  }
  out[spec.name] = raw;
}

/**
 * Render a `CommandSchema` + `usage` header into a help string.
 *
 * `usage` is the one-line synopsis (e.g. `"draft new [path] [options]"`).
 */
export function renderHelp(usage: string, schema: CommandSchema): string {
  const lines: string[] = [];
  lines.push(`Usage: ${usage}`);
  lines.push("");

  const pos = schema.positionals ?? [];
  if (pos.length > 0) {
    lines.push("Arguments:");
    for (const p of pos) {
      const label = p.variadic ? `<${p.name}...>` : `<${p.name}>`;
      lines.push(`  ${label.padEnd(22)} ${p.description ?? ""}`.trimEnd());
    }
    lines.push("");
  }

  const flags = schema.flags ?? [];
  if (flags.length > 0) {
    lines.push("Options:");
    lines.push(`  ${"-h, --help".padEnd(22)} Show this help and exit`);
    for (const f of flags) {
      const left = formatFlag(f);
      const desc = f.description ?? "";
      const req = f.required ? " (required)" : "";
      const def =
        f.default !== undefined && f.default !== "" && f.default !== false && !Array.isArray(f.default)
          ? ` (default: ${JSON.stringify(f.default)})`
          : "";
      const en = f.enum ? ` (one of: ${f.enum.join("|")})` : "";
      lines.push(`  ${left.padEnd(22)} ${desc}${req}${def}${en}`.trimEnd());
    }
    lines.push("");
  }

  return lines.join("\n");
}
