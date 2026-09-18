// ============================================================================
// FBX Diagnostics — structured warning collection
// ============================================================================
// Replaces the 8 console.log debug statements in the old parser.
// Warnings flow into ModelData.warnings; debug diagnostics are available
// via an optional verbose flag.
//

export type DiagnosticSeverity = "warning" | "debug";

export interface Diagnostic {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  context?: Record<string, unknown>;
}

/**
 * Collects diagnostics during FBX parsing.
 *
 * Warnings are non-fatal issues that should be surfaced to the user
 * (e.g. unsupported feature, missing data). Debug diagnostics are
 * informational and only collected when `verbose` is true.
 */
export class DiagnosticsCollector {
  private readonly warnings: Diagnostic[] = [];
  private readonly debugs: Diagnostic[] = [];
  readonly verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  /** Record a warning (always collected). */
  warn(code: string, message: string, context?: Record<string, unknown>): void {
    this.warnings.push({ code, message, severity: "warning", context });
  }

  /** Record a debug diagnostic (only when verbose). */
  debug(code: string, message: string, context?: Record<string, unknown>): void {
    if (this.verbose) {
      this.debugs.push({ code, message, severity: "debug", context });
    }
  }

  /** Get all warning messages (for ModelData.warnings). */
  getWarningMessages(): string[] {
    return this.warnings.map((w) => `[FBX:${w.code}] ${w.message}`);
  }

  /** Get all warnings. */
  getWarnings(): Diagnostic[] {
    return this.warnings;
  }

  /** Get all debug diagnostics. */
  getDebugs(): Diagnostic[] {
    return this.debugs;
  }

  /** Check if any warnings were collected. */
  hasWarnings(): boolean {
    return this.warnings.length > 0;
  }
}
