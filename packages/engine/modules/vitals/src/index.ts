// ============================================================================
// @downdraft/module-vitals — shared health / damage / death / respawn / meters
//
// `Vitals` tracks health, damage (with overkill + last-damage-time), death,
// respawn, delayed regen, and secondary meters (oxygen, energy, hunger, ...)
// against a caller-supplied host object so `p.health` stays a plain save
// field. Games wire death/damage UI through the config callbacks.
//
// The module wrapper provides a configured factory via DI for module-host
// games; hand-rolled sims can use `new Vitals(config, host)` directly.
// ============================================================================

import { resourceToken, type Module, type ModuleContext } from "@downdraft/core";
import { Vitals, type VitalsConfig, type VitalsHost } from "./vitals";

export { Vitals } from "./vitals";
export type {
    DamageEvent,
    MeterConfig,
    VitalsConfig,
    VitalsHost,
    VitalsSnapshot
} from "./vitals";

export type VitalsFactory<Cause = unknown, Host extends VitalsHost = VitalsHost> = (
  host: Host,
  overrides?: Partial<VitalsConfig<Cause, Host>>,
) => Vitals<Cause, Host>;

export const VitalsFactoryTok = resourceToken<VitalsFactory>("vitals:factory");

export function createVitalsModule<Cause = unknown, Host extends VitalsHost = VitalsHost>(
  config: VitalsConfig<Cause, Host>,
): Module {
  return {
    name: "vitals",
    version: "1.0.0",
    provides: [VitalsFactoryTok],
    register(ctx: ModuleContext) {
      ctx.provide(VitalsFactoryTok, (host, overrides) => new Vitals({ ...config, ...overrides } as VitalsConfig<Cause, Host>, host));
    },
  };
}
