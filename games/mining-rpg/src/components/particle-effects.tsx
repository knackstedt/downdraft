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

import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../stores/game-store";

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
  const [particles, setParticles] = useState<Particle[]>([]);
  const [floatTexts, setFloatTexts] = useState<FloatingText[]>([]);
  const rafRef = useRef(0);
  const particlesRef = useRef<Particle[]>([]);
  const floatTextsRef = useRef<FloatingText[]>([]);

  // Listen for particle spawn events via the store
  useEffect(() => {
    const originalSpawn = useGameStore.getState().spawnParticles;
    const originalFloat = useGameStore.getState().spawnFloatingText;
    useGameStore.setState({
      spawnParticles: (x: number, y: number, color: string, count: number) => {
        const now = performance.now();
        const newParts: Particle[] = [];
        for (let i = 0; i < count && particlesRef.current.length + newParts.length < MAX_PARTICLES; i++) {
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
        particlesRef.current = [...particlesRef.current, ...newParts];
      },
      spawnFloatingText: (x: number, y: number, text: string, color: string) => {
        if (floatTextsRef.current.length >= MAX_FLOATING_TEXTS) return;
        const now = performance.now();
        floatTextsRef.current = [...floatTextsRef.current, {
          id: textIdCounter++,
          x,
          y,
          text,
          color,
          born: now,
          life: FLOAT_TEXT_LIFE_MS,
        }];
      },
    });
    return () => {
      useGameStore.setState({ spawnParticles: originalSpawn, spawnFloatingText: originalFloat });
    };
  }, []);

  // Animation loop — update particle positions and remove dead ones
  useEffect(() => {
    const tick = () => {
      const now = performance.now();
      const aliveParts: Particle[] = [];
      for (let i = 0; i < particlesRef.current.length; i++) {
        const p = particlesRef.current[i];
        const age = now - p.born;
        if (age >= p.life) continue;
        p.vy += 0.08; // gravity
        p.x += p.vx;
        p.y += p.vy;
        aliveParts.push(p);
      }
      particlesRef.current = aliveParts;

      const aliveTexts: FloatingText[] = [];
      for (let i = 0; i < floatTextsRef.current.length; i++) {
        const t = floatTextsRef.current[i];
        const age = now - t.born;
        if (age >= t.life) continue;
        // Float upward
        t.y -= 0.5;
        aliveTexts.push(t);
      }
      floatTextsRef.current = aliveTexts;

      setParticles(aliveParts);
      setFloatTexts(aliveTexts);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  if (particles.length === 0 && floatTexts.length === 0) return null;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 13, overflow: "hidden" }}>
      {particles.map((p) => {
        const age = performance.now() - p.born;
        const lifePct = 1 - age / p.life;
        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: p.x,
              top: p.y,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: p.color,
              opacity: lifePct,
              transform: `scale(${lifePct})`,
              boxShadow: `0 0 ${p.size * 2}px ${p.color}`,
            }}
          />
        );
      })}
      {floatTexts.map((t) => {
        const age = performance.now() - t.born;
        const lifePct = 1 - age / t.life;
        return (
          <div
            key={t.id}
            style={{
              position: "absolute",
              left: t.x,
              top: t.y,
              color: t.color,
              fontSize: 16,
              fontWeight: "bold",
              fontFamily: "monospace",
              opacity: lifePct,
              textShadow: "0 0 4px rgba(0,0,0,0.8), 0 2px 2px rgba(0,0,0,0.6)",
              transform: `translate(-50%, -50%) scale(${1 + (1 - lifePct) * 0.3})`,
              whiteSpace: "nowrap",
            }}
          >
            {t.text}
          </div>
        );
      })}
    </div>
  );
}
