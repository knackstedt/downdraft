import type { Potion, Visitor, VisitorOfferResult, VisitorTemplate } from "../shared/types";
import { potionBaseValue } from "./bottling";

// ============================================================================
// Visitor system: ~20 templates with dark-humor gag dialog + haggle/negotiate.
// ============================================================================

export const VISITOR_TEMPLATES: VisitorTemplate[] = [
  {
    id: "widower",
    name: "Grieving Widower",
    face: "🥀",
    requestFlavor: [
      "My wife passed last week. Terrible tragedy.",
      "She was... an annoying woman. Very annoying.",
      "I need something to clean the basement. It's... messy.",
      "Do you have something that dissolves organic matter?",
    ],
    desiredEffects: ["dissolving-acid", "lawn-cleaner"],
    budgetRange: [40, 80],
    moodRange: [0.4, 0.7],
    patienceSec: [60, 90],
  },
  {
    id: "gardener",
    name: "Frustrated Gardener",
    face: "🌻",
    requestFlavor: [
      "My lawn is a DISASTER. Weeds everywhere.",
      "The neighbors are talking. I can hear them.",
      "I need something to kill weeds. All of them.",
      "Something corrosive. Something FINAL.",
    ],
    desiredEffects: ["lawn-cleaner", "dissolving-acid"],
    budgetRange: [20, 50],
    moodRange: [0.5, 0.8],
    patienceSec: [45, 75],
  },
  {
    id: "lovesick",
    name: "Lovesick Bard",
    face: "💘",
    requestFlavor: [
      "There's this person at the tavern. They won't look at me.",
      "I've tried sonnets. I've tried serenades. Nothing.",
      "I need a... persuasion aid. A love philter, perhaps?",
      "It's not creepy if it's alchemy. It's SCIENCE.",
    ],
    desiredEffects: ["love-philter"],
    budgetRange: [50, 100],
    moodRange: [0.3, 0.6],
    patienceSec: [60, 90],
  },
  {
    id: "villain",
    name: "Cackling Villain",
    face: "😈",
    requestFlavor: [
      "Hehehe. Hehehehe.",
      "My enemies. They think they're SO safe.",
      "I need something with... kick. Something that EXPLODES.",
      "Do you have anything that would, say, level a small keep?",
    ],
    desiredEffects: ["void-bomb", "spark-powder", "volatile-mix"],
    budgetRange: [80, 150],
    moodRange: [0.6, 0.9],
    patienceSec: [50, 80],
  },
  {
    id: "healer",
    name: "Desperate Healer",
    face: "⚕️",
    requestFlavor: [
      "My patient is dying. The wound won't close.",
      "I've tried everything. Prayer. Leeches. More prayer.",
      "I need a healing draught. A real one. Not water with food coloring.",
      "Please. I can pay well.",
    ],
    desiredEffects: ["healing-draught", "phoenix-tears"],
    budgetRange: [60, 120],
    moodRange: [0.5, 0.8],
    patienceSec: [40, 60],
  },
  {
    id: "necromancer",
    name: "Shady Necromancer",
    face: "💀",
    requestFlavor: [
      "I need something... dark. Something with gravitas.",
      "My apprentices keep quitting. Something about 'ethical concerns'.",
      "I need a necrotic blend. For... research purposes.",
      "The bodies aren't going to animate themselves.",
    ],
    desiredEffects: ["necrotic-blight", "grave-mist", "liquid-shadow"],
    budgetRange: [70, 130],
    moodRange: [0.4, 0.7],
    patienceSec: [70, 100],
  },
  {
    id: "insomniac",
    name: "Sleepless Merchant",
    face: "😩",
    requestFlavor: [
      "I haven't slept in six days. I see colors now.",
      "The colors are starting to talk to me.",
      "I need something to dream. To SLEEP.",
      "Something psychic. Something that'll shut my brain off.",
    ],
    desiredEffects: ["dream-vapor", "dream-narcotic", "moon-brew"],
    budgetRange: [40, 80],
    moodRange: [0.3, 0.5],
    patienceSec: [50, 70],
  },
  {
    id: "blacksmith",
    name: "Singed Blacksmith",
    face: "🔨",
    requestFlavor: [
      "My forge burned down. AGAIN.",
      "I need something that burns HOTTER. For the new forge.",
      "Something that'll melt dragon scale, if you know what I mean.",
      "Insurance won't cover another 'accident'.",
    ],
    desiredEffects: ["dragonfire"],
    budgetRange: [50, 90],
    moodRange: [0.5, 0.8],
    patienceSec: [55, 85],
  },
  {
    id: "assassin",
    name: "Quiet Stranger",
    face: "🗡️",
    requestFlavor: [
      "...",
      "I need something. Effective. Quiet.",
      "Something toxic. Very toxic.",
      "No questions. I pay in gold.",
    ],
    desiredEffects: ["nightshade-venom", "mercury-poison"],
    budgetRange: [90, 160],
    moodRange: [0.6, 0.9],
    patienceSec: [60, 90],
  },
  {
    id: "wizard",
    name: "Eccentric Wizard",
    face: "🧙",
    requestFlavor: [
      "I've been working on a spell. It requires... materials.",
      "Something ethereal. Something that glows.",
      "Preferably something that also explodes. I like explosions.",
      "My tower is too quiet these days.",
    ],
    desiredEffects: ["ether-bomb", "will-o-wisp", "starlight-tonic"],
    budgetRange: [60, 120],
    moodRange: [0.5, 0.8],
    patienceSec: [65, 95],
  },
  {
    id: "merchant",
    name: "Traveling Merchant",
    face: "🪙",
    requestFlavor: [
      "I hear you make interesting concoctions.",
      "I have buyers. Discreet buyers.",
      "Show me your best. Whatever it is. I'll know if it's worth it.",
      "Money is no object. Well, some object. But not much.",
    ],
    desiredEffects: [], // accepts any good potion
    budgetRange: [50, 200],
    moodRange: [0.4, 0.7],
    patienceSec: [70, 100],
  },
  {
    id: "rival",
    name: "Rival Alchemist",
    face: "🧪",
    requestFlavor: [
      "So. You think you're clever.",
      "I could make anything you sell. Better. Cheaper.",
      "But I'm feeling lazy. Show me your 'best work'.",
      "I'll grade it. Harshly.",
    ],
    desiredEffects: [], // accepts any potion, judges quality
    budgetRange: [40, 150],
    moodRange: [0.2, 0.5],
    patienceSec: [40, 60],
  },
  {
    id: "king",
    name: "Royal Messenger",
    face: "👑",
    requestFlavor: [
      "The King requires a potion. He did not say what kind.",
      "He said 'something impressive'. Those were his exact words.",
      "I suggest you impress him. The dungeon is... unpleasant.",
      "Make it glow. Kings love things that glow.",
    ],
    desiredEffects: ["starlight-tonic", "will-o-wisp", "phoenix-tears"],
    budgetRange: [100, 250],
    moodRange: [0.5, 0.8],
    patienceSec: [80, 120],
  },
  {
    id: "sailor",
    name: "Sea-Sick Sailor",
    face: "🤢",
    requestFlavor: [
      "Three months at sea. I can't stop vomiting.",
      "I need something to settle my stomach. Or my soul.",
      "Something... calming. Something that makes the world stop spinning.",
      "I'll pay anything. ANYTHING.",
    ],
    desiredEffects: ["moon-brew", "healing-draught"],
    budgetRange: [30, 60],
    moodRange: [0.3, 0.6],
    patienceSec: [40, 60],
  },
  {
    id: "gambler",
    name: "Desperate Gambler",
    face: "🎲",
    requestFlavor: [
      "I owe some people some money. A lot of money.",
      "I need something I can sell. Fast. For a lot.",
      "Something rare. Something that screams 'I'm worth thousands'.",
      "If I don't pay by midnight, I lose fingers.",
    ],
    desiredEffects: ["time-ender", "void-bomb", "phoenix-tears"],
    budgetRange: [80, 180],
    moodRange: [0.3, 0.6],
    patienceSec: [30, 50],
  },
  {
    id: "priest",
    name: "Doubtful Priest",
    face: "⛪",
    requestFlavor: [
      "I... I shouldn't be here. This is against everything I teach.",
      "But there's a child in my parish. Very sick.",
      "Prayer isn't working. I need... a miracle in a bottle.",
      "God won't mind. I hope. Please don't tell the bishop.",
    ],
    desiredEffects: ["phoenix-tears", "healing-draught"],
    budgetRange: [60, 140],
    moodRange: [0.6, 0.9],
    patienceSec: [60, 90],
  },
  {
    id: "artist",
    name: "Starving Artist",
    face: "🎨",
    requestFlavor: [
      "I need inspiration. REAL inspiration.",
      "Not this bourgeois 'paint what you see' nonsense.",
      "I need to SEE things. Things that aren't there.",
      "Something psychic. Something that opens the third eye.",
    ],
    desiredEffects: ["dream-vapor", "dream-narcotic"],
    budgetRange: [25, 50],
    moodRange: [0.4, 0.7],
    patienceSec: [50, 80],
  },
  {
    id: "soldier",
    name: "Scarred Soldier",
    face: "🪖",
    requestFlavor: [
      "The war took everything. My leg. My friends. My sleep.",
      "I need something to make me forget. Or to make me stop caring.",
      "Something strong. Something that burns the memories out.",
      "Or something that makes me angry enough to fight again.",
    ],
    desiredEffects: ["wrath-elixir", "dream-narcotic", "hate-flux"],
    budgetRange: [50, 100],
    moodRange: [0.3, 0.6],
    patienceSec: [55, 85],
  },
  {
    id: "noble",
    name: "Bored Noble",
    face: "🎩",
    requestFlavor: [
      "I have everything. I've done everything. I'm SO bored.",
      "I want something exciting. Something DANGEROUS.",
      "Something that would make my mother faint.",
      "Surprise me. I dare you.",
    ],
    desiredEffects: ["void-bomb", "ether-bomb", "time-ender"],
    budgetRange: [100, 300],
    moodRange: [0.4, 0.7],
    patienceSec: [60, 100],
  },
  {
    id: "farmer",
    name: "Worried Farmer",
    face: "🌾",
    requestFlavor: [
      "Something's been killing my livestock.",
      "I found... tracks. Not wolf tracks. Not bear tracks.",
      "I need something to protect the farm. Something that hurts.",
      "Whatever it is, it needs to learn to stay away.",
    ],
    desiredEffects: ["spark-powder", "dragonfire", "wrath-elixir"],
    budgetRange: [30, 70],
    moodRange: [0.5, 0.8],
    patienceSec: [50, 80],
  },
];

let visitorCounter = 0;

export function generateVisitor(): Visitor {
  const template = VISITOR_TEMPLATES[Math.floor(Math.random() * VISITOR_TEMPLATES.length)];
  visitorCounter++;
  return {
    id: `visitor-${Date.now()}-${visitorCounter}`,
    templateId: template.id,
    name: template.name,
    face: template.face,
    requestFlavor: template.requestFlavor,
    desiredEffects: template.desiredEffects,
    budget: template.budgetRange[0] + Math.random() * (template.budgetRange[1] - template.budgetRange[0]),
    mood: template.moodRange[0] + Math.random() * (template.moodRange[1] - template.moodRange[0]),
    patienceSec: template.patienceSec[0] + Math.random() * (template.patienceSec[1] - template.patienceSec[0]),
    arrivedAt: Date.now(),
  };
}

/**
 * Evaluate a potion offer against a visitor's request.
 * matchScore = how well the potion's effects match the visitor's desired effects.
 */
export function evaluateOffer(potion: Potion, visitor: Visitor): VisitorOfferResult {
  const potionEffects = new Set(potion.effects);
  let matchScore = 0;

  if (visitor.desiredEffects.length === 0) {
    // Generic buyer (merchant, rival) — values overall quality
    matchScore = Math.min(1, potion.effects.length / 3);
  } else {
    // Count how many desired effects are present
    const matched = visitor.desiredEffects.filter((id) => potionEffects.has(id)).length;
    matchScore = matched / visitor.desiredEffects.length;
  }

  const baseValue = potionBaseValue(potion);
  const moodMultiplier = 0.5 + visitor.mood * 0.5; // 0.5..1.0
  const matchMultiplier = 0.3 + matchScore * 0.7; // 0.3..1.0
  const finalPayout = Math.round(baseValue * matchMultiplier * moodMultiplier);

  // Response lines based on match quality
  const responseLines: string[] = [];
  if (matchScore >= 0.8) {
    responseLines.push("Yes! This is exactly what I need!");
    responseLines.push(`I'll pay ${finalPayout} gold for it.`);
  } else if (matchScore >= 0.5) {
    responseLines.push("Hmm. This will do, I suppose.");
    responseLines.push(`${finalPayout} gold. Take it or leave it.`);
  } else if (matchScore > 0) {
    responseLines.push("This... isn't quite what I asked for.");
    responseLines.push(`I'll give you ${finalPayout}. But I'm not happy about it.`);
  } else {
    responseLines.push("This is completely wrong. What are you trying to pull?");
    responseLines.push("Come back when you have what I actually need.");
  }

  const accepted = matchScore > 0;
  return { matchScore, basePayout: baseValue, moodMultiplier, finalPayout, responseLines, accepted };
}

/**
 * Haggle: try to raise the price. Risk of refusal based on mood + patience.
 * Returns new payout + whether the visitor accepts the haggled price.
 */
export function haggle(
  visitor: Visitor,
  currentPayout: number,
  raisePercent: number,
): { newPayout: number; accepted: boolean; responseLines: string[] } {
  const newPayout = Math.round(currentPayout * (1 + raisePercent / 100));
  // Chance of refusal increases with raise percentage and decreases with mood
  const refusalChance = Math.min(0.9, (raisePercent / 100) * (1.5 - visitor.mood));
  const accepted = Math.random() > refusalChance;

  const responseLines: string[] = [];
  if (accepted) {
    responseLines.push("Fine. FINE. But you're bleeding me dry.");
    responseLines.push(`${newPayout} gold. Final offer.`);
  } else {
    responseLines.push("Absolutely not. That's highway robbery.");
    responseLines.push("I'm leaving. Don't try to stop me.");
  }

  return { newPayout, accepted, responseLines };
}
