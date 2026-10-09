function tryExecSync(cmd: string, opts?: { shell?: string; stdio?: any[] }): string | null {
    try {
        const req = (globalThis as any).require;
        if (!req) return null;
        return req("child_process").execSync(cmd, opts).toString();
    } catch {
        return null;
    }
}

const proc: any = (globalThis as any).process ?? { env: {} as Record<string, string>, platform: "", stdout: undefined, stderr: undefined };

const BROKEN_PIPE_CODES = new Set(["EPIPE", "ECONNRESET", "EBADF", "EIO"]);

function isBrokenPipeError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    if ("code" in err && BROKEN_PIPE_CODES.has((err as { code: string }).code)) return true;
    if (err instanceof Error && err.message.includes("write EPIPE")) return true;
    return false;
}

function swallowStreamError(err: unknown): void {
    if (isBrokenPipeError(err)) return;
    throw err;
}

if (proc?.stdout?.on) proc.stdout.on("error", swallowStreamError);
if (proc?.stderr?.on) proc.stderr.on("error", swallowStreamError);

// ── Log sinks (for the native devtools console bridge) ──
// Sinks receive every log line (ANSI-stripped) so an external consumer like
// the devtools console can display logs that bypass console.log
// (the native logger writes directly to process.stdout, which CDP never sees).
export interface LogSinkEntry {
    level: string;      // "trace"|"debug"|"info"|"warn"|"error"|"fatal"
    module: string;
    message: string;    // ANSI/OSC-stripped clean message
    thread: string;     // thread tag (e.g. "R0", "M0", or "")
    timestamp: number;  // performance.now() at log time
}

export type LogSink = (entry: LogSinkEntry) => void;

const logSinks: Set<LogSink> = new Set();
// Ring buffer of recent log entries so a late-attaching sink (e.g. the
// devtools console, opened on demand) can replay history.
const recentLogs: LogSinkEntry[] = [];
const RECENT_LOG_CAP = 500;

function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function emitToSinks(entry: LogSinkEntry): void {
    recentLogs.push(entry);
    if (recentLogs.length > RECENT_LOG_CAP) recentLogs.shift();
    for (const sink of logSinks.values()) {
        try { sink(entry); } catch { /* sink errors must never break logging */ }
    }
}

/** Register a log sink. Returns an unsubscribe function. */
export function addLogSink(sink: LogSink): () => void {
    logSinks.add(sink);
    return () => { logSinks.delete(sink); };
}

/** Snapshot of the most recent log entries (newest last), capped at 500. */
export function getRecentLogs(): LogSinkEntry[] {
    return recentLogs.slice();
}

export interface Logger {
    trace(module: string, msg: string): void;
    debug(module: string, msg: string): void;
    info(module: string, msg: string): void;
    warn(module: string, msg: string): void;
    error(module: string, msg: string): void;
    fatal(module: string, msg: string): void;
}

const THEMES = {
    dark: {
        trace: "\x1b[38;2;69;197;139m",
        debug: "\x1b[38;2;82;148;226m",
        info: "\x1b[38;2;28;198;106m",
        warn: "\x1b[38;2;242;148;76m",
        error: "\x1b[38;2;255;110;110m",
        fatal: "\x1b[38;2;255;20;20m",
        module: "\x1b[38;2;82;148;226m",
        gray: "\x1b[38;2;128;128;128m",
        time: "\x1b[38;2;69;197;139m",
        thread: {
            M0: "\x1b[38;2;130;170;255m",
            M1: "\x1b[38;2;100;180;255m",
            R0: "\x1b[38;2;255;170;100m",
            R1: "\x1b[38;2;255;140;180m",
        } as Record<string, string>,
        jsonKey: "\x1b[38;2;156;220;254m",
        jsonString: "\x1b[38;2;206;145;120m",
        jsonNumber: "\x1b[38;2;181;206;168m",
        jsonBoolean: "\x1b[38;2;86;156;214m",
        jsonNull: "\x1b[38;2;86;156;214m",
        jsonBrace: "\x1b[38;2;128;128;128m",
    },
    light: {
        trace: "\x1b[38;2;12;157;118m",
        debug: "\x1b[38;2;2;122;232m",
        info: "\x1b[38;2;12;157;118m",
        warn: "\x1b[38;2;201;111;5m",
        error: "\x1b[38;2;200;80;80m",
        fatal: "\x1b[38;2;255;20;20m",
        module: "\x1b[38;2;2;122;232m",
        gray: "\x1b[38;2;100;100;100m",
        time: "\x1b[38;2;12;157;118m",
        thread: {
            M0: "\x1b[38;2;60;100;200m",
            M1: "\x1b[38;2;40;130;200m",
            R0: "\x1b[38;2;200;120;40m",
            R1: "\x1b[38;2;200;80;130m",
        } as Record<string, string>,
        jsonKey: "\x1b[38;2;1;36;86m",
        jsonString: "\x1b[38;2;163;21;21m",
        jsonNumber: "\x1b[38;2;0;100;0m",
        jsonBoolean: "\x1b[38;2;0;0;255m",
        jsonNull: "\x1b[38;2;0;0;255m",
        jsonBrace: "\x1b[38;2;80;80;80m",
    },
};

const reset = "\x1b[0m";
const bold = "\x1b[1m";

export function setThreadTag(tag: string): void {
    (globalThis as any).__ddThreadTag = tag;
}

function getThreadTag(): string {
    return (globalThis as any).__ddThreadTag ?? "";
}

const OSC8_START = "\x1b]8;;";
const OSC8_END = "\x1b]8;;";
const BEL = "\x07";

function isPathLike(str: string): boolean {
    return (
        str.startsWith("http://") ||
        str.startsWith("https://") ||
        str.startsWith("/") ||
        str.startsWith("file://") ||
        str.startsWith("ember://")
    );
}

function extractShorthand(pathOrUrl: string): string {
    const lineMatch = pathOrUrl.match(/(:\d+(?::\d+)?)$/);
    const lineSuffix = lineMatch ? lineMatch[1] : "";
    const withoutLine = lineSuffix
        ? pathOrUrl.slice(0, -lineSuffix.length)
        : pathOrUrl;

    try {
        const url = new URL(withoutLine);
        const parts = url.pathname.split("/").filter(Boolean);
        const filename = parts.pop() || url.pathname;
        return filename + lineSuffix;
    } catch {
        const parts = withoutLine.split(/[\\/]/).filter(Boolean);
        const filename = parts.pop() || withoutLine;
        return filename + lineSuffix;
    }
}

function getEditorScheme(): string {
    const termProgram = process.env.TERM_PROGRAM ?? "";
    if (termProgram === "vscode") return "vscode://file/";
    if (termProgram === "cursor") return "cursor://file/";
    if (termProgram === "windsurf") return "windsurf://file/";
    return "file://";
}

let _editorScheme: string | undefined;
function editorScheme(): string {
    return (_editorScheme ??= getEditorScheme());
}

function makeFileLink(filePath: string): string {
    const lineMatch = filePath.match(/(\d+)$/);
    const line = lineMatch ? lineMatch[1] : "";
    const path = line ? filePath.slice(0, -line.length - 1) : filePath;
    const scheme = editorScheme();
    if (scheme === "file://") {
        const url = path.startsWith("/") ? `file://${path}` : path;
        return makeTerminalLink(line ? `${url}:${line}` : url, extractShorthand(filePath));
    }
    const url = `${scheme}${path}:${line}`;
    return makeTerminalLink(url, extractShorthand(filePath));
}

function makeTerminalLink(target: string, text: string): string {
    return `${OSC8_START}${target}${BEL}${text}${OSC8_END}${BEL}`;
}

function linkifyModule(module: string): string {
    if (!isPathLike(module)) return module;
    return makeFileLink(module);
}

/** Normalize a module tag to the lowercase-kebab convention
 *  ("GameRenderer" → "game-renderer", "SIM WORKER" → "sim-worker").
 *  Only word-style names are rewritten — anything with heavier
 *  separators (paths, "plugin:x", "dev/hmr", bundle names like
 *  "chunk-5H6VXLYO.js:2419") already carries its own format and
 *  passes through untouched. */
function normalizeModuleTag(module: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9 _]*$/.test(module)) return module;
    return module
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
        .replace(/[\s_]+/g, "-")
        .toLowerCase();
}

function getJsonColors(theme: "light" | "dark") {
    const t = THEMES[theme];
    return {
        key: t.jsonKey,
        string: t.jsonString,
        number: t.jsonNumber,
        boolean: t.jsonBoolean,
        null: t.jsonNull,
        brace: t.jsonBrace,
    };
}

let _jsonColors: ReturnType<typeof getJsonColors> | undefined;
function jsonColors(): ReturnType<typeof getJsonColors> {
    return (_jsonColors ??= getJsonColors(getTheme()));
}

function highlightJson(json: string): string {
    let out = "";
    let i = 0;
    while (i < json.length) {
        const ch = json[i];
        if (ch === '"') {
            let end = i + 1;
            while (end < json.length) {
                if (json[end] === '\\') { end += 2; continue; }
                if (json[end] === '"') break;
                end++;
            }
            if (end >= json.length) {
                out += ch;
                i++;
                continue;
            }
            let str = json.slice(i, end + 1);
            // Check if this is a key (followed by colon, possibly with whitespace)
            let j = end + 1;
            while (j < json.length && /\s/.test(json[j])) j++;
            if (json[j] === ':') {
                out += jsonColors().key + str + reset;
            } else {
                // String value - also linkify ember:// URLs inside
                const inner = str.slice(1, -1);
                if (inner.startsWith("ember://")) {
                    const shorthand = extractShorthand(inner);
                    str = '"' + makeTerminalLink(inner, shorthand) + '"';
                }
                out += jsonColors().string + str + reset;
            }
            i = end + 1;
        } else if (/[\{\}\[\]]/.test(ch)) {
            out += jsonColors().brace + ch + reset;
            i++;
        } else if (/\d/.test(ch) || (ch === '-' && /\d/.test(json[i + 1]))) {
            let end = i + 1;
            while (end < json.length && /[\d.eE+\-]/.test(json[end])) end++;
            out += jsonColors().number + json.slice(i, end) + reset;
            i = end;
        } else if (json.slice(i, i + 4) === 'true') {
            out += jsonColors().boolean + 'true' + reset;
            i += 4;
        } else if (json.slice(i, i + 5) === 'false') {
            out += jsonColors().boolean + 'false' + reset;
            i += 5;
        } else if (json.slice(i, i + 4) === 'null') {
            out += jsonColors().null + 'null' + reset;
            i += 4;
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

function highlightText(text: string): string {
    const colors = jsonColors();
    let out = "";
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        // Skip placeholders (e.g. __JSON_0__, __LINK_0__) so their digits aren't highlighted
        if (text.startsWith("__JSON_", i) || text.startsWith("__LINK_", i)) {
            const end = text.indexOf("__", i + 7);
            if (end !== -1) {
                out += text.slice(i, end + 2);
                i = end + 2;
                continue;
            }
        }
        // Quoted strings (double and single)
        if (ch === '"' || ch === "'") {
            const quote = ch;
            let end = i + 1;
            while (end < text.length) {
                if (text[end] === '\\') { end += 2; continue; }
                if (text[end] === quote) break;
                end++;
            }
            if (end < text.length) {
                out += colors.string + text.slice(i, end + 1) + reset;
                i = end + 1;
                continue;
            }
            // Unterminated — just output the rest
            out += colors.string + text.slice(i) + reset;
            break;
        }
        // Numbers (integer, decimal, negative)
        if (/\d/.test(ch) || (ch === '-' && /\d/.test(text[i + 1]))) {
            let end = i + 1;
            while (end < text.length && /[\d.]/.test(text[end])) end++;
            out += colors.number + text.slice(i, end) + reset;
            i = end;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

function extractJsonBlobs(msg: string): { text: string; start: number; end: number }[] {
    const blobs: { text: string; start: number; end: number }[] = [];
    for (let i = 0; i < msg.length; i++) {
        if (msg[i] === "{" || msg[i] === "[") {
            const start = i;
            const open = msg[i];
            const close = open === "{" ? "}" : "]";
            let depth = 1;
            let inString = false;
            let escaped = false;
            for (let j = i + 1; j < msg.length; j++) {
                const ch = msg[j];
                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (ch === "\\") {
                        escaped = true;
                    } else if (ch === '"') {
                        inString = false;
                    }
                } else {
                    if (ch === '"') {
                        inString = true;
                    } else if (ch === open) {
                        depth++;
                    } else if (ch === close) {
                        depth--;
                        if (depth === 0) {
                            const text = msg.slice(start, j + 1);
                            try {
                                JSON.parse(text);
                                blobs.push({ text, start, end: j + 1 });
                            } catch {
                                // not valid JSON
                            }
                            i = j;
                            break;
                        }
                    }
                }
            }
        }
    }
    return blobs;
}

function linkifyMessage(msg: string): string {
    // Extract JSON blobs first so link replacements don't interfere with them
    const jsonBlobs = extractJsonBlobs(msg);
    let placeholderIndex = 0;
    for (let i = jsonBlobs.length - 1; i >= 0; i--) {
        const blob = jsonBlobs[i];
        msg =
            msg.slice(0, blob.start) +
            `__JSON_${placeholderIndex++}__` +
            msg.slice(blob.end);
    }

    // Linkify URLs, ember:// URIs, and bare file paths in a single pass.
    // Running these as separate regex passes would re-match file paths inside
    // the OSC 8 escape sequences produced by the URL pass, producing nested
    // \x1b]8;;...\x07 sequences that render as visible "8;;" / ";;" fragments.
    const linkPattern = new RegExp(
        "(https?://[^\\s\\)]+)" +                   // group 1: http(s) URLs
        "|(ember://[^\\s\\)]+)" +                   // group 2: ember URIs
        "|(/(?:[^\\s:]+/)+[^\\s:)]+:\\d+(?::\\d+)?)" // group 3: bare file paths
        , "g"
    );
    const links: string[] = [];
    msg = msg.replace(linkPattern, (_match, httpUrl: string | undefined, emberUrl: string | undefined, filePath: string | undefined) => {
        const target = httpUrl ?? emberUrl ?? `file://${filePath}`;
        const link = makeTerminalLink(target, extractShorthand(target));
        links.push(link);
        return `__LINK_${links.length - 1}__`;
    });

    // Highlight numbers and quoted strings in remaining text
    msg = highlightText(msg);

    // Restore linkified spans after highlightText so color codes don't
    // corrupt the OSC 8 escape sequences inside the links.
    for (let i = 0; i < links.length; i++) {
        msg = msg.replace(`__LINK_${i}__`, links[i]);
    }

    // Restore JSON blobs with syntax highlighting
    for (let i = 0; i < placeholderIndex; i++) {
        msg = msg.replace(
            `__JSON_${i}__`,
            highlightJson(jsonBlobs[placeholderIndex - 1 - i].text)
        );
    }

    return msg;
}

let _theme: "light" | "dark" | undefined;

function getTheme(): "light" | "dark" {
    if (_theme) return _theme;

    const colorfgbg = proc.env.COLORFGBG;
    if (colorfgbg) {
        const parts = colorfgbg.split(";");
        if (parts.length > 1) {
            const bg = parseInt(parts[parts.length - 1]);
            if (bg >= 0 && bg <= 7) return (_theme = "dark");
            if (bg >= 8 && bg <= 15) return (_theme = "light");
        }
    }

    if (proc.platform !== "win32" && proc.stdout?.isTTY) {
        try {
            const probe = `
                if [ -t 0 ]; then
                    stty -echo
                    printf "\\033]11;?\\007"
                    read -d $'\\a' -s -t 0.1 response
                    stty echo
                    echo $response
                fi
            `;
            const response = tryExecSync(probe, {
                shell: "/bin/bash",
                stdio: ["inherit", "pipe", "ignore"],
            });
            if (response && response.includes("rgb:")) {
                const match = response.match(
                    /rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/
                );
                if (match) {
                    const r = parseInt(match[1], 16);
                    const g = parseInt(match[2], 16);
                    const b = parseInt(match[3], 16);
                    const brightness =
                        (r * 0.299 + g * 0.587 + b * 0.114) /
                        (Math.pow(16, match[1].length) - 1);
                    return (_theme = brightness > 0.5 ? "light" : "dark");
                }
            }
        } catch {
            // OSC 11 failed, continue to fallbacks
        }
    }

    if (proc.platform === "darwin") {
        try {
            const style = tryExecSync("defaults read -g AppleInterfaceStyle", {
                stdio: ["ignore", "pipe", "ignore"],
            });
            if (style !== null && style.trim() === "Dark") return (_theme = "dark");
        } catch {
            return (_theme = "light");
        }
    } else if (proc.platform === "linux") {
        try {
            const style = tryExecSync(
                "gsettings get org.gnome.desktop.interface color-scheme",
                { stdio: ["ignore", "pipe", "ignore"] }
            );
            if (style !== null) {
                const trimmed = style.trim().replace(/'/g, "");
                if (trimmed === "prefer-dark" || trimmed.includes("dark"))
                    return (_theme = "dark");
                if (trimmed === "prefer-light" || trimmed.includes("light"))
                    return (_theme = "light");
            }
        } catch { }

        try {
            const style = tryExecSync(
                "dbus-send --session --print-reply=literal --dest=org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.Settings.Read string:'org.freedesktop.appearance' string:'color-scheme'",
                { stdio: ["ignore", "pipe", "ignore"] }
            );
            if (style && style.includes("uint32 1")) return (_theme = "dark");
            if (style && style.includes("uint32 2")) return (_theme = "light");
        } catch { }
    }

    return (_theme = "dark");
}

export class ConsoleLogger implements Logger {
    private readonly palette: (typeof THEMES)["dark"];

    constructor(private readonly level: number) {
        this.palette = THEMES[getTheme()];
    }

    private write(level: string, module: string, msg: string) {
        const cleanMsg = msg.replace(/\n+$/, "");
        const color = (this.palette as any)[level];
        const timestamp = new Date().toTimeString().slice(0, 8);
        const moduleName = normalizeModuleTag(module);
        const linkedModule = linkifyModule(moduleName);
        let moduleStr: string;
        if (isPathLike(moduleName)) {
            moduleStr = linkedModule;
        } else {
            moduleStr = `${this.palette.module}${moduleName}`;
        }
        const tag = getThreadTag();
        const tagColor = (this.palette.thread as Record<string, string>)[tag] ?? this.palette.module;
        const prefix = tag
            ? `${this.palette.gray}[${tagColor}${tag}${reset}${this.palette.gray}/${moduleStr}${this.palette.gray}] `
            : `${this.palette.gray}[${moduleStr}${this.palette.gray}] `;
        const line = `${this.palette.time}${timestamp} ${color}${bold}${level.toUpperCase()}${reset} ${prefix}${reset}${linkifyMessage(cleanMsg)}\n`;

        // Notify log sinks (native devtools console bridge) with clean text.
        emitToSinks({
            level,
            module: moduleName,
            message: stripAnsi(cleanMsg),
            thread: tag,
            timestamp: (typeof performance !== "undefined" ? performance.now() : Date.now()),
        });

        if (proc?.stdout?.write && proc?.stderr?.write) {
            const stream = proc.env.DOWNDRAFT_MCP === "1" ? proc.stderr : proc.stdout;
            try {
                stream.write(line);
            } catch (e: any) {
                if (isBrokenPipeError(e)) return;
                throw e;
            }
        } else {
            // Browser fallback — strip ANSI codes
            const clean = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
            const fn = level === "error" || level === "fatal" ? console.error : level === "warn" ? console.warn : console.log;
            fn(clean);
        }
    }

    trace(module: string, msg: string) {
        this.level <= 1 && this.write("trace", module, msg);
    }

    debug(module: string, msg: string) {
        this.level <= 2 && this.write("debug", module, msg);
    }

    info(module: string, msg: string) {
        this.level <= 3 && this.write("info", module, msg);
    }

    warn(module: string, msg: string) {
        this.level <= 4 && this.write("warn", module, msg);
    }

    error(module: string, msg: string) {
        this.level <= 5 && this.write("error", module, msg);
    }

    fatal(module: string, msg: string) {
        this.level <= 6 && this.write("fatal", module, msg);
    }
}

const levelIntMap: Record<string, number> = {
    trace: 1,
    debug: 2,
    info: 3,
    warn: 4,
    error: 5,
    fatal: 6,
};

export function createLogger(
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal" =
        proc.env.NODE_ENV === "test" ? "warn" : "info"
): Logger {
    const effectiveLevel = proc.env.EMBER_LOG_LEVEL || level;
    return new ConsoleLogger(levelIntMap[effectiveLevel] ?? 3);
}
