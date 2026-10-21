import { describe, test, expect } from "bun:test";
import { freshLexState, lineTokens, isCompleteExpression, type TokKind } from "../src/syntax/js";

function kinds(src: string): { text: string; k: TokKind }[] {
  const { toks } = lineTokens(src, freshLexState());
  return toks.filter((t) => t.k !== "plain").map((t) => ({ text: src.slice(t.s, t.e), k: t.k }));
}

describe("lineTokens", () => {
  test("keywords, numbers, operators", () => {
    const ks = kinds("const x = 42;");
    expect(ks).toContainEqual({ text: "const", k: "keyword" });
    expect(ks).toContainEqual({ text: "42", k: "number" });
    expect(ks.some((t) => t.k === "operator")).toBe(true);
  });

  test("strings with escapes and embedded quotes", () => {
    const ks = kinds(`let s = 'a\\'b' + "c";`);
    expect(ks).toContainEqual({ text: `'a\\'b'`, k: "string" });
    expect(ks).toContainEqual({ text: '"c"', k: "string" });
  });

  test("line comment consumes the rest", () => {
    const ks = kinds("x // tail comment");
    expect(ks).toContainEqual({ text: "// tail comment", k: "comment" });
  });

  test("block comments carry state across lines", () => {
    const l1 = lineTokens("const /* a", freshLexState());
    expect(l1.end.inComment).toBe(true);
    const l2 = lineTokens("b */ x", l1.end);
    expect(l2.end.inComment).toBe(false);
    expect(l2.toks[0]).toEqual({ s: 0, e: 4, k: "comment" });
  });

  test("template literals", () => {
    const ks = kinds("`a${x}b`");
    expect(ks).toContainEqual({ text: "`a${", k: "template" });
    expect(ks).toContainEqual({ text: "`", k: "template" });
    // The interpolated expression is tokenized as code, not template text.
    const raw = lineTokens("`a${x}b`", freshLexState());
    expect(raw.toks.some((t) => t.k === "plain" && "`a${x}b`".slice(t.s, t.e) === "x")).toBe(true);
  });

  test("unterminated template keeps inTemplate state", () => {
    const r = lineTokens("const s = `abc", freshLexState());
    expect(r.end.inTemplate).toBe(true);
  });

  test("regex literal after operator vs division after identifier", () => {
    const re = kinds("= /ab+c/g;");
    expect(re.some((t) => t.k === "regex" && t.text.startsWith("/ab"))).toBe(true);
    const div = kinds("a / b / c");
    expect(div.every((t) => t.k !== "regex")).toBe(true);
    // A division "/" becomes a lone operator, never swallows operands.
    const div2 = kinds("x = a / b");
    expect(div2).toContainEqual({ text: "/", k: "operator" });
    expect(div2.every((t) => t.k !== "regex")).toBe(true);
  });

  test("builtins and capitalized names get their own kinds", () => {
    const ks = kinds("JSON.parse(new Foo())");
    expect(ks).toContainEqual({ text: "JSON", k: "builtin" });
    expect(ks).toContainEqual({ text: "parse", k: "property" });
    expect(ks).toContainEqual({ text: "Foo", k: "type" });
  });
});

describe("isCompleteExpression", () => {
  test("complete inputs eval on Enter", () => {
    ["1 + 2", "const o = {a: 1}", "`a${x}b`", "foo(bar)", "a.b.c"].forEach((src) => {
      expect(isCompleteExpression(src)).toBe(true);
    });
  });

  test("open constructs wait for more input", () => {
    ["function f() {", "const a = [1,", "`abc", "/* block", "x =", "return"].forEach((src) => {
      expect(isCompleteExpression(src)).toBe(false);
    });
  });

  test("dangling operators ask for continuation", () => {
    ["a +", "obj.", "x ?"].forEach((src) => {
      expect(isCompleteExpression(src)).toBe(false);
    });
  });
});
