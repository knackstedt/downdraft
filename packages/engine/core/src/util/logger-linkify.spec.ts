import { describe, expect, it } from "bun:test";

// Re-implement the minimum needed to test linkifyMessage in isolation.
// We import the real logger internals by reaching into the module's
// non-exported functions via a small harness.

// Since linkifyMessage is not exported, we test through the public ConsoleLogger
// and inspect the raw ANSI output by intercepting stdout.
import { createLogger } from "./logger.ts";

describe("linkifyMessage — no nested OSC 8", () => {
    it("does not produce nested OSC 8 sequences for URLs containing file paths", () => {
        // Simulate a Vite dev stack-trace line that triggered the bug:
        //   at createFallingSandScene (http://localhost:51748/src/game-scene.ts:298:13)
        const msg = "    at createFallingSandScene (http://localhost:51748/src/game-scene.ts:298:13)";

        // Capture stdout.write
        const origWrite = process.stdout.write.bind(process.stdout);
        let captured = "";
        process.stdout.write = ((chunk: any) => {
            captured += chunk.toString();
            return true;
        }) as any;

        try {
            const logger = createLogger("trace");
            logger.warn("chunk-5H6VXLYO.js:2419", msg);
        } finally {
            process.stdout.write = origWrite;
        }

        // Count OSC 8 start sequences (\x1b]8;;). There should be exactly 1
        // for the URL — not 2 (which would indicate nested linkification).
        const osc8Starts = (captured.match(/\x1b\]8;;/g) || []).length;
        const osc8Ends = (captured.match(/\x07/g) || []).length;

        expect(osc8Starts).toBe(2); // 1 start + 1 end marker, both use \x1b]8;;
        expect(osc8Ends).toBe(2);   // 1 after target + 1 after end marker

        // The visible text (after stripping ANSI/OSC) should NOT contain "8;;"
        const visible = captured
            .replace(/\x1b\[[0-9;]*m/g, "")
            .replace(/\x1b\][^\x07]*\x07/g, "");
        expect(visible).not.toContain("8;;");
        expect(visible).toContain("game-scene.ts:298:13");
    });

    it("linkifies a bare file path without nesting", () => {
        const msg = "    at handleInit (/home/user/src/worker.ts:185:21)";

        const origWrite = process.stdout.write.bind(process.stdout);
        let captured = "";
        process.stdout.write = ((chunk: any) => {
            captured += chunk.toString();
            return true;
        }) as any;

        try {
            const logger = createLogger("trace");
            logger.warn("test", msg);
        } finally {
            process.stdout.write = origWrite;
        }

        const osc8Starts = (captured.match(/\x1b\]8;;/g) || []).length;
        expect(osc8Starts).toBe(2); // 1 link = 2 \x1b]8;; markers (start + end)

        const visible = captured
            .replace(/\x1b\[[0-9;]*m/g, "")
            .replace(/\x1b\][^\x07]*\x07/g, "");
        expect(visible).not.toContain("8;;");
        expect(visible).toContain("worker.ts:185:21");
    });

    it("linkifies multiple URLs in one message without interference", () => {
        const msg = "See http://example.com/a.ts:10:5 and http://example.com/b.ts:20:3";

        const origWrite = process.stdout.write.bind(process.stdout);
        let captured = "";
        process.stdout.write = ((chunk: any) => {
            captured += chunk.toString();
            return true;
        }) as any;

        try {
            const logger = createLogger("trace");
            logger.warn("test", msg);
        } finally {
            process.stdout.write = origWrite;
        }

        const osc8Starts = (captured.match(/\x1b\]8;;/g) || []).length;
        expect(osc8Starts).toBe(4); // 2 links = 4 \x1b]8;; markers

        const visible = captured
            .replace(/\x1b\[[0-9;]*m/g, "")
            .replace(/\x1b\][^\x07]*\x07/g, "");
        expect(visible).not.toContain("8;;");
    });
});
