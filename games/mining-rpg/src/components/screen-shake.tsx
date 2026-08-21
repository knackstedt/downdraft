// ============================================================================
// ScreenShake — applies a brief CSS shake animation to the game container
// when the player takes damage.
//
// The shake is triggered via the `triggerScreenShake` method on the game
// store, which is called from the renderer when health decreases. The
// intensity scales with the damage amount.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../stores/game-store";

export function ScreenShake() {
  const [shakeKey, setShakeKey] = useState(0);
  const [intensity, setIntensity] = useState(1);
  const rafRef = useRef(0);

  // Listen for shake triggers
  useEffect(() => {
    const original = useGameStore.getState().triggerScreenShake;
    useGameStore.setState({
      triggerScreenShake: (amt: number) => {
        setIntensity(Math.min(3, Math.max(0.5, amt / 20)));
        setShakeKey((k) => k + 1);
      },
    });
    return () => {
      useGameStore.setState({ triggerScreenShake: original });
    };
  }, []);

  // Apply shake to the game canvas + overlays by toggling a class
  useEffect(() => {
    if (shakeKey === 0) return;
    const canvas = document.querySelector("canvas");
    if (!canvas) return;
    const start = performance.now();
    const duration = 300;
    const animate = () => {
      const elapsed = performance.now() - start;
      if (elapsed >= duration) {
        canvas.style.transform = "";
        return;
      }
      const progress = elapsed / duration;
      const decay = 1 - progress;
      const shake = intensity * decay * 3;
      const x = (Math.random() - 0.5) * shake;
      const y = (Math.random() - 0.5) * shake;
      canvas.style.transform = `translate(${x}px, ${y}px)`;
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [shakeKey, intensity]);

  return null;
}
