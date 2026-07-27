import React from "react";
import { useGameStore } from "../stores/gameStore";

export default function CharacterCustomization() {
  const toggle = useGameStore((s) => s.toggleCharacterCustomization);
  const [char, setChar] = React.useState({
    bodyType: 0,
    bodyScaleX: 1, bodyScaleY: 1, bodyScaleZ: 1,
    headShape: 0,
    hairStyle: 0,
    hairColor: 0,
    skinTone: 0,
    eyeColor: 0,
    outfit: 0,
  });

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-auto" onClick={toggle}>
      <div className="hud-panel p-6 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-2xl font-bold text-ocean-100 mb-4">Character</h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <h3 className="text-sm text-ocean-300 mb-2">Body</h3>
            <Slider label="Body Type" value={char.bodyType} min={0} max={3} onChange={(v) => setChar({ ...char, bodyType: v })} />
            <Slider label="Width" value={char.bodyScaleX} min={0.5} max={2} step={0.1} onChange={(v) => setChar({ ...char, bodyScaleX: v })} />
            <Slider label="Height" value={char.bodyScaleY} min={0.5} max={2} step={0.1} onChange={(v) => setChar({ ...char, bodyScaleY: v })} />
            <Slider label="Depth" value={char.bodyScaleZ} min={0.5} max={2} step={0.1} onChange={(v) => setChar({ ...char, bodyScaleZ: v })} />
          </div>
          <div>
            <h3 className="text-sm text-ocean-300 mb-2">Head</h3>
            <Slider label="Head Shape" value={char.headShape} min={0} max={5} onChange={(v) => setChar({ ...char, headShape: v })} />
            <Slider label="Hair Style" value={char.hairStyle} min={0} max={10} onChange={(v) => setChar({ ...char, hairStyle: v })} />
            <Slider label="Hair Color" value={char.hairColor} min={0} max={20} onChange={(v) => setChar({ ...char, hairColor: v })} />
            <Slider label="Skin Tone" value={char.skinTone} min={0} max={10} onChange={(v) => setChar({ ...char, skinTone: v })} />
            <Slider label="Eye Color" value={char.eyeColor} min={0} max={10} onChange={(v) => setChar({ ...char, eyeColor: v })} />
          </div>
        </div>

        <div className="mt-4">
          <h3 className="text-sm text-ocean-300 mb-2">Outfit</h3>
          <div className="flex gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <button
                key={i}
                className={`w-12 h-12 rounded-lg border-2 ${char.outfit === i ? "border-ocean-400 bg-ocean-700" : "border-ocean-700 bg-ocean-800"}`}
                onClick={() => setChar({ ...char, outfit: i })}
              />
            ))}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-secondary" onClick={toggle}>Cancel</button>
          <button className="btn-primary" onClick={toggle}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs text-ocean-400 mb-1">
        <span>{label}</span>
        <span>{value.toFixed(1)}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full"
      />
    </div>
  );
}
