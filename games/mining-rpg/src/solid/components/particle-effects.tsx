// ============================================================================
// ParticleEffects — DOM-based particle system for visual feedback.
//
// Spawns colored particle bursts when ore is collected, and floating damage
// numbers when the player takes damage. Particles are rendered as
// absolutely-positioned divs that animate upward and fade out.
//
// The system is lightweight (max 60 particles + 20 floating texts at a time)
// and cleans up after animations complete.
//
// Particles are triggered via the `spawnParticles` and `spawnFloatingText`
// methods on the game store, which are called from the renderer.
// ============================================================================

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { setGameStore } from "../stores/game-store";

interface Particle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  born: number;
  life: number;
}

interface FloatingText {
  id: number;
  x: number;
  y: number;
  text: string;
  color: string;
  born: number;
  life: number;
}

const MAX_PARTICLES = 60;
const MAX_FLOATING_TEXTS = 20;
const PARTICLE_LIFE_MS = 800;
const FLOAT_TEXT_LIFE_MS = 1200;

let particleIdCounter = 0;
let textIdCounter = 0;

export function ParticleEffects() {
  const [particles, setParticles] = createSignal<Particle[]>([]);
  const [floatTexts, setFloatTexts] = createSignal<FloatingText[]>([]);
  let particlesRef: Particle[] = [];
  let floatTextsRef: FloatingText[] = [];

  // Listen for particle spawn events via the store
  onMount(() => {
    setGameStore("_spawnParticles", (x: number, y: number, color: string, count: number) => {
      const now = performance.now();
      const newParts: Particle[] = [];
      for (let i = 0; i < count && particlesRef.length + newParts.length < MAX_PARTICLES; i++) {
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
        const speed = 1 + Math.random() * 2;
        newParts.push({
          id: particleIdCounter++,
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1, // bias upward
          color,
          size: 3 + Math.random() * 3,
          born: now,
          life: PARTICLE_LIFE_MS,
        });
      }
      particlesRef = [...particlesRef, ...newParts];
    });
    setGameStore("_spawnFloatingText", (x: number, y: number, text: string, color: string) => {
      if (floatTextsRef.length >= MAX_FLOATING_TEXTS) return;
      const now = performance.now();
      floatTextsRef = [...floatTextsRef, {
        id: textIdCounter++,
        x,
        y,
        text,
        color,
        born: now,
        life: FLOAT_TEXT_LIFE_MS,
      }];
    });

    // Animation loop — update particle positions and remove dead ones
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const aliveParts: Particle[] = [];
      for (let i = 0; i < particlesRef.length; i++) {
        const p = particlesRef[i];
        const age = now - p.born;
        if (age >= p.life) continue;
        p.vy += 0.08; // gravity
        p.x += p.vx;
        p.y += p.vy;
        aliveParts.push(p);
      }
      particlesRef = aliveParts;

      const aliveTexts: FloatingText[] = [];
      for (let i = 0; i < floatTextsRef.length; i++) {
        const t = floatTextsRef[i];
        const age = now - t.born;
        if (age >= t.life) continue;
        // Float upward
        t.y -= 0.5;
        aliveTexts.push(t);
      }
      floatTextsRef = aliveTexts;

      setParticles(aliveParts);
      setFloatTexts(aliveTexts);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      setGameStore("_spawnParticles", undefined);
      setGameStore("_spawnFloatingText", undefined);
    });
  });

  return (
    <Show when={particles().length > 0 || floatTexts().length > 0}>
      <div style={{ position: "absolute", inset: 0, "pointer-events": "none", "z-index": "13", overflow: "hidden" }}>
        <For each={particles()}>
          {(p) => {
            const age = performance.now() - p.born;
            const lifePct = 1 - age / p.life;
            return (
              <div
                style={{
                  position: "absolute",
                  left: `${p.x}px`,
                  top: `${p.y}px`,
                  width: `${p.size}px`,
                  height: `${p.size}px`,
                  "border-radius": "50%",
                  background: p.color,
                  opacity: lifePct,
                  transform: `scale(${lifePct})`,
                  "box-shadow": `0 0 ${p.size * 2}px ${p.color}`,
                }}
              />
            );
          }}
        </For>
        <For each={floatTexts()}>
          {(t) => {
            const age = performance.now() - t.born;
            const lifePct = 1 - age / t.life;
            return (
              <div
                style={{
                  position: "absolute",
                  left: `${t.x}px`,
                  top: `${t.y}px`,
                  color: t.color,
                  "font-size": "16px",
                  "font-weight": "bold",
                  "font-family": "monospace",
                  opacity: lifePct,
                  "text-shadow": "0 0 4px rgba(0,0,0,0.8), 0 2px 2px rgba(0,0,0,0.6)",
                  transform: `translate(-50%, -50%) scale(${1 + (1 - lifePct) * 0.3})`,
                  "white-space": "nowrap",
                }}
              >
                {t.text}
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
