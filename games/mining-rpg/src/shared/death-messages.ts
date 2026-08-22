// ============================================================================
// Death messages — a single object covering all death causes.
//
// Material-based deaths (lava, fire, gas, etc.) are keyed by Material ID.
// Non-material deaths (suffocation, falling) are keyed by DeathCause IDs
// (1000+). Each cause has a list of quips; one is picked at random.
//
// Shared between the React (main-thread) and Solid (worker) stores.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { DeathCause } from "./constants";

const DEATH_MESSAGES: Record<number, string[]> = {
  // --- Material-based deaths (keyed by Material ID) ---
  [Material.Lava]: [
    "Maybe don't try jumping in lava",
    "That was magma, not a hot tub",
    "Lava: it's not a spa treatment",
    "You do know that lava is hot, right?",
    "Didn't your parents ever teach you to not touch lava?",
    "Caution: lava is hot and may cause severe injury or even death",
    "What made you think that jumping in a pool of lava was a good idea?"
  ],
  [Material.Fire]: [
    "Stop, drop, and roll next time",
    "You got a little too toasty",
    "Fire is hot, who knew",
    "I know it may be a bit late to say this, but don't stand on fire",
    "Warning: Death by fire is not covered under your health plan"
  ],
  [Material.Plasma]: [
    "that's some premium incineration",
    "plasma: not just a state of matter, it's a lifestyle",
    "what the hell was that?"
  ],
  [Material.FuseFire]: [
    "should've cut the red wire",
    "Now you know why it says 'Parental Supervision required'.",
  ],
  [Material.BurningOil]: [
    "Oil and fire — a classic afternoon combo",
    "I don't know why you thought taking a bath in boiling oil was a good idea",
    "Did you know that not swimming in burning oil is a requirement for survival?"
  ],
  [Material.MethaneGas]: [
    "Breathing isn't optional",
    "Methane: the silent killer (well, not that silent)",
    "Should've brought a gas mask",
    "I know you can't see it, but you sure as hell can smell it"
  ],
  [Material.SulfurGas]: [
    "Breathing isn't optional",
    "Sulfur gas: smells like death, tastes like it too",
    "That's some toxic air right now",
    "You could have smelled that from so far away"
  ],

  // --- Non-material deaths (keyed by DeathCause ID) ---
  [DeathCause.Suffocation]: [
    "Crushed under the weight of the earth",
    "The mountain doesn't move, you do",
    "Should've dug faster",
    "Rocks fall, everyone dies",
    "Do you like hugs with extreme force?",
    "Cave-ins are a serious source of injury and death",
    "Buried alive — then you become dead",
    "Next time, watch where you dig",
    "You should have paid attention to the cracks in the ceiling"
  ],
  [DeathCause.Falling]: [
    "It's not the fall that kills you, it's the sudden stop",
    "Gravity called, you answered",
    "Should've packed a parachute",
    "The ground came up fast, didn't it?",
    "Splat. That's the technical term.",
    "Next time, try landing on your feet",
    "You fell for it — literally!",
    "That was quite the leap of faith.",
    "Did you forget your umbrella?",
    "Terminal velocity is not a suggestion"
  ],
  [DeathCause.Drowning]: [
    "You should have come up for air",
    "Glub glub glub",
    "This just in: you are not a fish.",
    "Waterboarding: not just for interrogations anymore!",
    "Should've taken swimming lessons",
    "You held your breath for a really long time, just not long enough",
    "Reminder: breathing is compulsory",
    "Who would have thought that you couldn't drink all that water",
    "Looks like you forgot your floaty",
    "Maybe next time try the kiddie pool",
    "Congratulations, you just learned that you can drown in this game",
  ],
};

// Fallback for unrecognized death causes (shouldn't happen, but just in case)
const FALLBACK_QUIPS = [
  "The mine claims another soul",
  "Your health insurance plan isn't unlimited you know",
  "Act 2; The Consequences of your actions",
  "While you don't feel pain, he does",
  "How'd you manage that",
  "What are you doing, running around like you have free healthcare"
];

/** Pick a random death quip for the given cause (Material ID or DeathCause ID). */
export function pickDeathQuip(deathCause: number): string {
  const quips = DEATH_MESSAGES[deathCause] ?? FALLBACK_QUIPS;
  return quips[Math.floor(Math.random() * quips.length)];
}
