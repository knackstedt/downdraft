/** Type declarations for dev-constants.mjs (plain-JS module shared between
 *  the dev supervisor and the runner-side runtime). Keep in sync. */

export const DD_RESTART_EXIT: number;
export const CONFIG_KEY: string;
export const SUPERVISOR_KEY: string;
export const HMR_KEY: string;
export const LISTENERS_FLAG: string;
export const EV: {
  simHotReload: string;
  simHotReloadAck: string;
  rendererHotReload: string;
  hostRestart: string;
};
export const DEFAULT_PROCESS_RESTART_PATTERNS: string[];
export const DEFAULT_HOST_RESTART_PATTERNS: string[];
export const DEFAULT_SIM_PATTERNS: string[];
