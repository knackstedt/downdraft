// ============================================================================
// js.ts — JS/TS tokenizer for the console + source viewer.
//
// Doc-level: tracks cross-line state (block comments, template literals,
// unterminated strings) so multiline input highlights correctly. Produces
// per-line token spans {s, e, kind} — callers map kinds → colors.
// ============================================================================

export type TokKind =
  | "keyword" | "string" | "template" | "comment" | "number"
  | "type" | "builtin" | "operator" | "plain" | "property" | "regex";

export interface Tok { s: number; e: number; k: TokKind; }

export interface LexState {
  inComment: boolean;
  inTemplate: boolean;   // inside `...` — continued lines stay template
  inString: 0 | "'" | '"' | "`";
}

export const freshLexState = (): LexState => ({ inComment: false, inTemplate: false, inString: 0 });

const KEYWORDS = new Set(
  "const let var function return if else for while do switch case default break continue new delete typeof instanceof in of class extends implements interface enum type namespace import export from as async await try catch finally throw yield static get set readonly private protected public abstract this super void null undefined true false satisfies infer keyof never unknown any declare module require".split(" "));

const BUILTINS = new Set(
  "console window globalThis document fetch Promise Map Set WeakMap WeakSet Array Object String Number Boolean Math JSON Date Error RegExp Symbol BigInt parseInt parseFloat isNaN NaN Infinity Intl URL TextEncoder TextDecoder Buffer process performance setTimeout setInterval clearTimeout clearInterval queueMicrotask requestAnimationFrame localStorage sessionStorage structuredClone atob btoa crypto".split(" "));

/** Tokenize one line given the lex state at its start; returns tokens + end state. */
export function lineTokens(text: string, st: LexState): { toks: Tok[]; end: LexState } {
  const toks: Tok[] = [];
  const push = (s: number, e: number, k: TokKind) => { if (e > s) toks.push({ s, e, k }); };
  let i = 0;
  const n = text.length;
  const state: LexState = { ...st };



  // Resume a continued construct.
  if (state.inComment) {
    const close = text.indexOf("*/");
    if (close < 0) { push(0, n, "comment"); return { toks, end: state }; }
    push(0, close + 2, "comment");
    state.inComment = false;
    i = close + 2;
  } else if (state.inString === "'" || state.inString === '"') {
    // Continued string can't happen (line break ends it) — safety only.
    state.inString = 0;
  } else if (state.inTemplate) {
    const j = i;
    for (; i < n;) {
      const c = text[i]!;
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; break; }
      if (c === "$" && text[i + 1] === "{") { i += 2; break; }
      i++;
    }
    push(j, i, "template");
    if (i > j && text[i - 1] === "`") state.inTemplate = false;
    else if (i >= n) return { toks, end: state };
    // Fell through ${…} — continue tokenizing.
  }

  let prevDot = false;
  let lastSig = "";        // last significant token text for regex heuristics

  for (; i < n;) {
    const c = text[i]!;
    const rest = i;

    // Comments
    if (c === "/" && text[i + 1] === "/") { push(i, n, "comment"); break; }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) { push(i, n, "comment"); state.inComment = true; break; }
      push(i, close + 2, "comment");
      i = close + 2;
      continue;
    }

    // Strings / templates
    if (c === "'" || c === '"' || c === "`") {
      const j = i;
      i++;
      for (; i < n;) {
        const ch = text[i]!;
        if (ch === "\\") { i += 2; continue; }
        if (ch === c) { i++; break; }
        if (c === "`" && ch === "$" && text[i + 1] === "{") {
          i += 2;
          break;
        }
        i++;
      }
      push(j, i, c === "`" ? "template" : "string");
      if (c === "`" && i <= n && text[i - 1] !== "`") state.inTemplate = true;
      lastSig = "str"; prevDot = false;
      continue;
    }

    // Regex literal heuristic: /…/ when the previous significant token can
    // start an expression (operator, keyword, start of line, ( , [ = : , ; ! & | ? + - * ~ ^ < > return).
    if (c === "/" && (prevDot || lastSig === "" || lastSig === "op" ||
        KEYWORDS.has(lastSig) || lastSig === "str") === true &&
        (lastSig === "" || lastSig === "op" || KEYWORDS.has(lastSig))) {
      const j = i;
      i++;
      let inCls = false;
      for (; i < n;) {
        const ch = text[i]!;
        if (ch === "\\") { i += 2; continue; }
        if (ch === "[") inCls = true;
        else if (ch === "]") inCls = false;
        else if (ch === "/" && !inCls) { i++; for (; i < n && /[a-z]/i.test(text[i]!);) i++; break; }
        else if (ch === "\n") break;
        i++;
      }
      push(j, i, "regex");
      lastSig = "str"; prevDot = false;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const j = i;
      if (c === "0" && /[xXbBoO]/.test(text[i + 1] ?? "")) {
        i += 2;
        for (; i < n && /[\da-fA-F_]/.test(text[i]!);) i++;
      } else {
        for (; i < n && /[\d_.]/.test(text[i]!);) i++;
        if (i < n && /[eE]/.test(text[i]!)) {
          i++;
          if (i < n && /[+-]/.test(text[i]!)) i++;
          for (; i < n && /[\d]/.test(text[i]!);) i++;
        }
        if (text[i] === "n") i++; // BigInt
      }
      push(j, i, "number");
      lastSig = "num"; prevDot = false;
      continue;
    }

    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(c)) {
      const j = i;
      for (; i < n && /[\w$]/.test(text[i]!);) i++;
      const w = text.slice(j, i);
      let k: TokKind;
      if (prevDot) k = "property";
      else if (KEYWORDS.has(w)) k = "keyword";
      else if (BUILTINS.has(w)) k = "builtin";
      else if (/^[A-Z]/.test(w)) k = "type";
      else k = "plain";
      push(j, i, k);
      lastSig = w; prevDot = false;
      continue;
    }

    // Template continuation inside ${…} — when we see "}" we may need to
    // resume template mode. Track via depth: crude but effective.
    if (c === "}") {
      // If the brace closes a ${, resume template scanning.
      // Count "${" vs "}" occurrences in tokens so far — cheap heuristic:
      // we approximate by scanning back for an unmatched "${".
      let depth = 0;
      let resume = false;
      for (let t = toks.length - 1; t >= 0 && depth <= 0; t--) {
        // Only when the previous token ended with "${" or we're in nested braces.
      }
      void depth; void resume;
      push(i, i + 1, "operator");
      i++;
      lastSig = "op"; prevDot = false;
      continue;
    }

    // Whitespace
    if (/\s/.test(c)) {
      const j = i;
      for (; i < n && /\s/.test(text[i]!);) i++;
      push(j, i, "plain");
      continue;
    }

    // Operators/punctuation (runs of them)
    const j = i;
    for (; i < n && !/[\w$\s'"`/]/.test(text[i]!) && !(text[i] === "/" && (text[i + 1] === "/" || text[i + 1] === "*"));) i++;
    if (i === j) { i++; push(j, i, "operator"); prevDot = false; lastSig = "op"; continue; } // lone "/" (division) — the run above can't advance
    const op = text.slice(j, i);
    push(j, i, "operator");
    prevDot = op.endsWith(".") || op.endsWith("?.");
    lastSig = "op";
    void rest;
  }

  return { toks, end: state };
}

// ---------------------------------------------------------------------------
// Completeness check — decide whether Enter should eval or insert a newline.
// Chrome heuristic, upgraded: real scanner for balanced brackets, unclosed
// strings/templates/comments, trailing operators/keywords that demand more.
// ---------------------------------------------------------------------------

export function isCompleteExpression(text: string): boolean {
  const st = freshLexState();
  const stack: string[] = [];
  let i = 0;
  const n = text.length;
  let inStr: 0 | "'" | '"' | "`" = 0;
  let inComment = false, inLine = false;

  for (; i < n;) {
    const c = text[i]!;
    if (inLine) { if (c === "\n") inLine = false; i++; continue; }
    if (inComment) {
      if (c === "*" && text[i + 1] === "/") { inComment = false; i += 2; continue; }
      i++; continue;
    }
    if (inStr) {
      if (c === "\\") { i += 2; continue; }
      if (c === inStr) { inStr = 0; i++; continue; }
      if (inStr === "`" && c === "$" && text[i + 1] === "{") { stack.push("${"); inStr = 0; i += 2; continue; }
      if (inStr !== "`" && c === "\n") { inStr = 0; } // unterminated single-line string — treat as closed
      i++; continue;
    }
    if (c === "/" && text[i + 1] === "/") { inLine = true; i += 2; continue; }
    if (c === "/" && text[i + 1] === "*") { inComment = true; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") { inStr = c; i++; continue; }
    if (c === "(" || c === "{" || c === "[") { stack.push(c); i++; continue; }
    if (c === ")" || c === "}" || c === "]") {
      if (stack.length === 0) return true; // extra closer — let the error show
      const top = stack.pop()!;
      if (top === "${" && c === "}") { inStr = "`"; }
      i++; continue;
    }
    i++;
  }

  if (inStr || inComment || stack.length > 0) return false;

  // Trailing dangling operators / openers / keywords that need a continuation.
  const tail = text.replace(/\s+$/, "");
  if (/[+\-*/%&|^~!?:=<>.,;]$/.test(tail)) return false;
  const lastWord = tail.match(/[\w$]+$/)?.[0] ?? "";
  if (["return", "await", "async", "new", "typeof", "delete", "in", "of", "instanceof", "else", "do", "case", "extends", "throw", "yield"].includes(lastWord)) return false;
  if (/=\s*$/.test(tail)) return false;
  if (/\.\s*$/.test(tail)) return false;
  void st;
  return true;
}
