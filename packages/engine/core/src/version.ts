// ============================================================================
// version.ts — ENGINE_VERSION as a leaf module.
//
// Lives outside the root barrel (index.ts re-exports it) so startup-critical
// consumers — platform-native's createNativeHost, the shared feature-log —
// can take a @downdraft/engine/version edge instead of pulling the whole
// barrel subtree into the dev transform graph.
// ============================================================================

import pkg from "../../package.json" with { type: "json" };

/** Engine semver — single source of truth is package.json. */
export const ENGINE_VERSION: string = pkg.version;
