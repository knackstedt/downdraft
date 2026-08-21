// ============================================================================
// ParticleEffects — DOM-based particle system for visual feedback.
//
// Spawns colored particle bursts when ore is collected. Particles are
// rendered as absolutely-positioned divs that animate upward and fade out.
// The system is lightweight (max 50 particles at a time) and cleans up
// after the animation completes.
//
// Particles are triggered via the `spawnParticles` method on the game store,
// which is called from the renderer when items are collected.
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

const MAX_PARTICLES = 60;
const PARTICLE_LIFE_MS = 800;

// Material → particle color mapping
const MAT_COLORS: Record<number, string> = {
  0: "#ffffff",
  // Ores
  10: "#b3b4b8", // TinOre
  11: "#b87333", // CopperOre
  12: "#8c7365", // IronOre
  13: "#bf8066", // BauxiteOre
  14: "#d9d9e0", // SilverOre
  15: "#e6c833", // GoldOre
  16: "#4059cc", // CobaltOre
  17: "#1a1a1a", // Coal
};

let particleIdCounter = 0;

export function ParticleEffects() {
  const [particles, setParticles] = useState<Particle[]>([]);
  const rafRef = useRef(0);
  const particlesRef = useRef<Particle[]>([]);

  // Listen for particle spawn events via the store
  useEffect(() => {
    const originalSpawn = useGameStore.getState().spawnParticles;
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
    });
    return () => {
      useGameStore.setState({ spawnParticles: originalSpawn });
    };
  }, []);

  // Animation loop — update particle positions and remove dead ones
  useEffect(() => {
    const tick = () => {
      const now = performance.now();
      const alive: Particle[] = [];
      for (let i = 0; i < particlesRef.current.length; i++) {
        const p = particlesRef.current[i];
        const age = now - p.born;
        if (age >= p.life) continue;
        // Apply gravity and update position
        p.vy += 0.08; // gravity
        p.x += p.vx;
        p.y += p.vy;
        alive.push(p);
      }
      particlesRef.current = alive;
      setParticles(alive);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  if (particles.length === 0) return null;

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
    </div>
  );
}
