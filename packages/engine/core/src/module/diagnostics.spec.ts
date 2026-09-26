import { resourceToken } from "../ecs/resource";
import { addLogSink } from "../util/logger";
import { assertNoDuplicate, assertRequired, DiagnosticError, isStrict, setStrict, warnLeak } from "./diagnostics";

const Tok = resourceToken<number>("test:tok");
const OtherTok = resourceToken<string>("test:other");

describe("diagnostics", () => {
  describe("assertNoDuplicate", () => {
    it("passes when token is not yet provided", () => {
      const providers = new Map<string, string>();
      expect(() => assertNoDuplicate(providers, Tok, "plugin-a")).not.toThrow();
    });

    it("throws DiagnosticError when token is already provided", () => {
      const providers = new Map<string, string>([["test:tok", "plugin-a"]]);
      expect(() => assertNoDuplicate(providers, Tok, "plugin-b")).toThrow(DiagnosticError);
      expect(() => assertNoDuplicate(providers, Tok, "plugin-b")).toThrow(/already provided by "plugin-a"/);
    });
  });

  describe("assertRequired", () => {
    it("passes when token has a provider", () => {
      const providers = new Map<string, string>([["test:tok", "plugin-a"]]);
      expect(() => assertRequired(providers, Tok, "plugin-b")).not.toThrow();
    });

    it("throws DiagnosticError when no provider", () => {
      const providers = new Map<string, string>();
      expect(() => assertRequired(providers, OtherTok, "plugin-b")).toThrow(DiagnosticError);
      expect(() => assertRequired(providers, OtherTok, "plugin-b")).toThrow(/plugin-b.*test:other/);
    });
  });

  describe("warnLeak", () => {
    let warnings: string[];
    let unbindSink: () => void;

    beforeEach(() => {
      warnings = [];
      unbindSink = addLogSink((e) => {
        if (e.level === "warn") warnings.push(e.message);
      });
    });
    afterEach(() => {
      unbindSink();
    });

    it("does not warn when dispose fns are registered", () => {
      warnLeak("plugin-a", { providedCount: 5, sabCount: 2, disposeFnCount: 1 });
      expect(warnings.length).toBe(0);
    });

    it("does not warn when no resources/SABs were provided", () => {
      warnLeak("plugin-a", { providedCount: 0, sabCount: 0, disposeFnCount: 0 });
      expect(warnings.length).toBe(0);
    });

    it("warns when resources provided but no dispose fns", () => {
      warnLeak("plugin-a", { providedCount: 3, sabCount: 0, disposeFnCount: 0 });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("plugin-a");
      expect(warnings[0]).toContain("3 resource(s)");
    });

    it("warns when SAB channels allocated but no dispose fns", () => {
      warnLeak("plugin-a", { providedCount: 0, sabCount: 2, disposeFnCount: 0 });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("2 SAB channel(s)");
    });
  });

  describe("setStrict", () => {
    it("can be toggled", () => {
      setStrict(true);
      expect(isStrict()).toBe(true);
      setStrict(false);
      expect(isStrict()).toBe(false);
    });
  });
});

