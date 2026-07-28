import { AnimatePresence, motion } from "framer-motion";
import {
    Gamepad2,
    Keyboard,
    LogOut,
    Monitor,
    Play,
    Volume2,
    type LucideIcon,
} from "lucide-react";
import React from "react";
import { simBridge } from "../simBridge";
import { useGameStore } from "../stores/gameStore";

type TabId = "gameplay" | "audio" | "graphics" | "controls";

interface TabDef {
  id: TabId;
  label: string;
  icon: LucideIcon;
}

const TABS: TabDef[] = [
  { id: "gameplay", label: "Gameplay", icon: Gamepad2 },
  { id: "audio", label: "Audio", icon: Volume2 },
  { id: "graphics", label: "Graphics", icon: Monitor },
  { id: "controls", label: "Controls", icon: Keyboard },
];

export default function SettingsPanel() {
  const toggle = useGameStore((s) => s.toggleSettings);
  const [activeTab, setActiveTab] = React.useState<TabId>("gameplay");

  const [settings, setSettings] = React.useState({
    // Gameplay
    difficulty: "normal",
    autoSaveInterval: 120,
    splitscreen: "1p",
    hudOpacity: 1.0,
    collisionLodDistance: 250,
    reticleSize: 80,
    // Audio
    masterVolume: 0.8,
    musicVolume: 0.6,
    sfxVolume: 0.8,
    ambientVolume: 0.5,
    // Graphics
    renderDistance: 2048,
    waterGridSize: 256,
    terrainGridSize: 128,
    waterQuality: "high",
    particleDensity: 1.0,
    fov: 60,
    vsync: true,
    textureQuality: "high",
    shadows: "medium",
    pixelationEnabled: false,
    pixelSize: 6,
    depthEdgeStrength: 0.4,
    // Post-processing effects
    fxaaEnabled: false,
    dofEnabled: false,
    dofFocusDist: 0.5,
    dofFocusRange: 0.3,
    dofMaxBlur: 8,
    sobelEnabled: false,
    afterimageEnabled: false,
    afterimageDamp: 0.96,
    bloomEnabled: false,
    bloomThreshold: 0.8,
    bloomStrength: 1.0,
    asciiEnabled: false,
    asciiCellSize: 8,
    asciiUseColor: true,
    // Controls
    firstPersonSensitivity: 1.0,
    thirdPersonSensitivity: 1.0,
    freecamSensitivity: 1.0,
    invertY: false,
    keybindings: {
      forward: "W",
      back: "S",
      left: "A",
      right: "D",
      interact: "E",
      inventory: "I",
      map: "M",
      build: "B",
    },
  });

  const update = <K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const handleResume = () => {
    const s = useGameStore.getState();
    if (s.showPauseMenu) s.togglePauseMenu();
    toggle();
  };

  const handleExit = () => {
    simBridge.quit();
  };

  // --- Keyboard navigation ---
  const rootRef = React.useRef<HTMLDivElement>(null);
  const sidebarRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [navPane, setNavPane] = React.useState<"sidebar" | "content">("sidebar");
  const [navIndex, setNavIndex] = React.useState(0);
  const [adjusting, setAdjusting] = React.useState(false);
  const sidebarIdxRef = React.useRef(0);
  const contentIdxRef = React.useRef(0);

  React.useEffect(() => { rootRef.current?.focus(); }, []);

  const getItems = (pane: "sidebar" | "content") => {
    const ref = pane === "sidebar" ? sidebarRef : contentRef;
    return Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-focusable]") ?? []);
  };

  const switchPane = (newPane: "sidebar" | "content") => {
    if (newPane === navPane) return;
    if (navPane === "sidebar") sidebarIdxRef.current = navIndex;
    else contentIdxRef.current = navIndex;
    setNavPane(newPane);
    setNavIndex(newPane === "sidebar" ? sidebarIdxRef.current : contentIdxRef.current);
  };

  const activateItem = (item: HTMLElement | undefined) => {
    if (!item) return;
    switch (item.getAttribute("data-control-type")) {
      case "tab": case "button": case "toggle": case "keybind":
        item.querySelector<HTMLButtonElement>("button")?.click(); break;
      case "select": {
        const s = item.querySelector<HTMLSelectElement>("select");
        if (s) { s.selectedIndex = (s.selectedIndex + 1) % s.options.length; s.dispatchEvent(new Event("change", { bubbles: true })); }
        break;
      }
      case "slider": setAdjusting(true); break;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (contentRef.current?.querySelector("[data-listening]")) return;
    const items = getItems(navPane);
    if (items.length === 0) return;
    const key = e.key.toLowerCase();

    if (adjusting) {
      const input = items[navIndex]?.querySelector<HTMLInputElement>("input[type=range]");
      if (!input) { setAdjusting(false); return; }
      if (["w","a","arrowup","arrowleft"].includes(key)) {
        e.preventDefault();
        const step = parseFloat(input.step);
        input.value = String(Math.max(parseFloat(input.min), parseFloat(input.value) - step));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (["s","d","arrowdown","arrowright"].includes(key)) {
        e.preventDefault();
        const step = parseFloat(input.step);
        input.value = String(Math.min(parseFloat(input.max), parseFloat(input.value) + step));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (key === " " || key === "enter" || key === "escape") {
        e.preventDefault(); setAdjusting(false);
      }
      return;
    }

    switch (key) {
      case "w": case "arrowup":
        e.preventDefault(); setNavIndex(i => Math.max(0, i - 1)); break;
      case "s": case "arrowdown":
        e.preventDefault(); setNavIndex(i => Math.min(items.length - 1, i + 1)); break;
      case "a": case "arrowleft":
        e.preventDefault(); if (navPane === "content") switchPane("sidebar"); break;
      case "d": case "arrowright":
        e.preventDefault(); if (navPane === "sidebar") switchPane("content"); break;
      case " ": case "enter":
        e.preventDefault(); activateItem(items[navIndex]); break;
      case "escape":
        e.preventDefault(); if (navPane === "content") switchPane("sidebar"); else toggle(); break;
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (adjusting) setAdjusting(false);
    else if (navPane === "content") switchPane("sidebar");
    else toggle();
  };

  React.useEffect(() => {
    contentIdxRef.current = 0;
    if (navPane === "content") setNavIndex(0);
  }, [activeTab]);

  React.useEffect(() => {
    document.querySelectorAll<HTMLElement>("[data-focused]").forEach(el => el.removeAttribute("data-focused"));
    const items = getItems(navPane);
    const el = items[navIndex];
    el?.setAttribute("data-focused", "true");
    el?.scrollIntoView({ block: "nearest" });
  }, [navPane, navIndex, activeTab, adjusting]);

  return (
    <div
      className="w-full h-full flex items-center justify-center pointer-events-auto bg-ocean-950/80 outline-none"
      onClick={toggle}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      tabIndex={-1}
      data-adjusting={adjusting ? "true" : undefined}
      ref={rootRef}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="hud-panel w-[760px] max-w-[90vw] h-[540px] max-h-[85vh] flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar */}
        <div ref={sidebarRef} className="w-52 shrink-0 bg-ocean-950/60 border-r border-ocean-700/50 flex flex-col">
          <h2 className="text-xl font-bold text-ocean-100 px-5 pt-5 pb-4">Settings</h2>
          <nav className="flex-1 px-3 space-y-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  data-focusable
                  data-control-type="tab"
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                    active
                      ? "bg-ocean-500 text-white"
                      : "text-ocean-300 hover:bg-ocean-800/60 hover:text-ocean-100"
                  }`}
                >
                  <Icon size={18} className="shrink-0" />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Action buttons */}
          <div className="p-3 space-y-1 border-t border-ocean-700/50">
            <button
              data-focusable
              data-control-type="button"
              onClick={handleResume}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-ocean-100 bg-ocean-700 hover:bg-ocean-600 transition-all duration-150"
            >
              <Play size={18} className="shrink-0" />
              Resume
            </button>
            <button
              data-focusable
              data-control-type="button"
              onClick={handleExit}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-white bg-coral-600 hover:bg-coral-500 transition-all duration-150"
            >
              <LogOut size={18} className="shrink-0" />
              Exit
            </button>
          </div>
        </div>

        {/* Content */}
        <div ref={contentRef} className="flex-1 overflow-y-auto p-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.15 }}
              className="space-y-5"
            >
              {activeTab === "gameplay" && (
                <GameplayTab settings={settings} update={update as any} />
              )}
              {activeTab === "audio" && (
                <AudioTab settings={settings} update={update as any} />
              )}
              {activeTab === "graphics" && (
                <GraphicsTab settings={settings} update={update as any} />
              )}
              {activeTab === "controls" && (
                <ControlsTab settings={settings} update={update as any} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab content components
// ---------------------------------------------------------------------------

interface TabProps {
  settings: any;
  update: (key: string, value: any) => void;
}

function GameplayTab({ settings, update }: TabProps) {
  return (
    <>
      <SectionTitle>Gameplay</SectionTitle>
      <SettingSelect
        label="Difficulty"
        value={settings.difficulty}
        options={["peaceful", "easy", "normal", "hard", "hardcore"]}
        onChange={(v) => update("difficulty", v)}
      />
      <SettingSlider
        label="Auto-Save Interval"
        value={settings.autoSaveInterval}
        min={0} max={600} step={30}
        onChange={(v) => update("autoSaveInterval", v)}
        unit="s"
      />
      <SettingSelect
        label="Splitscreen Layout"
        value={settings.splitscreen}
        options={["1p", "2p-horizontal", "2p-vertical", "3p-top-wide", "4p-corners"]}
        onChange={(v) => update("splitscreen", v)}
      />
      <SettingSlider
        label="HUD Opacity"
        value={settings.hudOpacity}
        min={0.2} max={1} step={0.05}
        onChange={(v) => update("hudOpacity", v)}
      />
      <SettingSlider
        label="Collision Distance"
        value={settings.collisionLodDistance}
        min={50} max={1000} step={50}
        onChange={(v) => {
          update("collisionLodDistance", v);
          simBridge.setSetting("collisionLodDistance", v);
        }}
        unit="m"
      />
      <SettingSlider
        label="Reticle Size"
        value={settings.reticleSize}
        min={20} max={160} step={4}
        onChange={(v) => {
          update("reticleSize", v);
          useGameStore.getState().setReticleSize(v);
        }}
        unit="px"
      />
    </>
  );
}

function AudioTab({ settings, update }: TabProps) {
  return (
    <>
      <SectionTitle>Audio</SectionTitle>
      <SettingSlider
        label="Master Volume"
        value={settings.masterVolume}
        min={0} max={1} step={0.05}
        onChange={(v) => update("masterVolume", v)}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <SettingSlider
        label="Music Volume"
        value={settings.musicVolume}
        min={0} max={1} step={0.05}
        onChange={(v) => update("musicVolume", v)}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <SettingSlider
        label="SFX Volume"
        value={settings.sfxVolume}
        min={0} max={1} step={0.05}
        onChange={(v) => update("sfxVolume", v)}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <SettingSlider
        label="Ambient Volume"
        value={settings.ambientVolume}
        min={0} max={1} step={0.05}
        onChange={(v) => update("ambientVolume", v)}
        format={(v) => `${Math.round(v * 100)}%`}
      />
    </>
  );
}

function GraphicsTab({ settings, update }: TabProps) {
  return (
    <>
      <SectionTitle>Graphics</SectionTitle>
      <SettingSlider
        label="Render Distance"
        value={settings.renderDistance}
        min={512} max={4096} step={256}
        onChange={(v) => update("renderDistance", v)}
        unit="m"
      />
      <SettingSlider
        label="Water Grid Size"
        value={settings.waterGridSize}
        min={64} max={512} step={64}
        onChange={(v) => update("waterGridSize", v)}
      />
      <SettingSlider
        label="Terrain Grid Size"
        value={settings.terrainGridSize}
        min={32} max={256} step={32}
        onChange={(v) => update("terrainGridSize", v)}
      />
      <SettingSelect
        label="Water Quality"
        value={settings.waterQuality}
        options={["low", "medium", "high", "ultra"]}
        onChange={(v) => update("waterQuality", v)}
      />
      <SettingSelect
        label="Texture Quality"
        value={settings.textureQuality}
        options={["low", "medium", "high", "ultra"]}
        onChange={(v) => update("textureQuality", v)}
      />
      <SettingSelect
        label="Shadows"
        value={settings.shadows}
        options={["off", "low", "medium", "high"]}
        onChange={(v) => update("shadows", v)}
      />
      <SettingSlider
        label="Particle Density"
        value={settings.particleDensity}
        min={0} max={2} step={0.1}
        onChange={(v) => update("particleDensity", v)}
      />
      <SettingSlider
        label="Field of View"
        value={settings.fov}
        min={60} max={120} step={5}
        onChange={(v) => update("fov", v)}
        unit="°"
      />
      <SettingToggle
        label="V-Sync"
        value={settings.vsync}
        onChange={(v) => update("vsync", v)}
      />
      <div className="pt-2 border-t border-ocean-700/40">
        <div className="text-sm text-ocean-300 mb-2">Pixelation Effect</div>
        <SettingToggle
          label="Enable Pixelation"
          value={settings.pixelationEnabled}
          onChange={(v) => {
            update("pixelationEnabled", v);
            useGameStore.getState().renderer?.setPixelationEnabled(v);
          }}
        />
        {settings.pixelationEnabled && (
          <>
            <div className="mt-3">
              <SettingSlider
                label="Pixel Size"
                value={settings.pixelSize}
                min={1} max={16} step={1}
                onChange={(v) => {
                  update("pixelSize", v);
                  useGameStore.getState().renderer?.setPixelSize(v);
                }}
              />
            </div>
            <div className="mt-3">
              <SettingSlider
                label="Depth Edge Strength"
                value={settings.depthEdgeStrength}
                min={0} max={1} step={0.05}
                onChange={(v) => {
                  update("depthEdgeStrength", v);
                  useGameStore.getState().renderer?.setDepthEdgeStrength(v);
                }}
              />
            </div>
          </>
        )}
      </div>
      <div className="pt-2 border-t border-ocean-700/40">
        <div className="text-sm text-ocean-300 mb-2">Post-Processing Effects</div>
        <SettingToggle
          label="FXAA (Anti-Aliasing)"
          value={settings.fxaaEnabled}
          onChange={(v) => {
            update("fxaaEnabled", v);
            useGameStore.getState().renderer?.setPostProcessEnabled("fxaa", v);
          }}
        />
        <SettingToggle
          label="Depth of Field"
          value={settings.dofEnabled}
          onChange={(v) => {
            update("dofEnabled", v);
            useGameStore.getState().renderer?.setPostProcessEnabled("dof", v);
          }}
        />
        {settings.dofEnabled && (
          <>
            <div className="mt-3">
              <SettingSlider
                label="Focus Distance"
                value={settings.dofFocusDist}
                min={0} max={1} step={0.01}
                onChange={(v) => {
                  update("dofFocusDist", v);
                  useGameStore.getState().renderer?.setDOFFocusDist(v);
                }}
              />
            </div>
            <div className="mt-3">
              <SettingSlider
                label="Focus Range"
                value={settings.dofFocusRange}
                min={0} max={1} step={0.01}
                onChange={(v) => {
                  update("dofFocusRange", v);
                  useGameStore.getState().renderer?.setDOFFocusRange(v);
                }}
              />
            </div>
            <div className="mt-3">
              <SettingSlider
                label="Max Blur"
                value={settings.dofMaxBlur}
                min={1} max={20} step={1}
                onChange={(v) => {
                  update("dofMaxBlur", v);
                  useGameStore.getState().renderer?.setDOFMaxBlur(v);
                }}
              />
            </div>
          </>
        )}
        <SettingToggle
          label="Sobel Edge Detection"
          value={settings.sobelEnabled}
          onChange={(v) => {
            update("sobelEnabled", v);
            useGameStore.getState().renderer?.setPostProcessEnabled("sobel", v);
          }}
        />
        <SettingToggle
          label="Afterimage (Motion Trail)"
          value={settings.afterimageEnabled}
          onChange={(v) => {
            update("afterimageEnabled", v);
            useGameStore.getState().renderer?.setPostProcessEnabled("afterimage", v);
          }}
        />
        {settings.afterimageEnabled && (
          <div className="mt-3">
            <SettingSlider
              label="Trail Damp"
              value={settings.afterimageDamp}
              min={0} max={0.99} step={0.01}
              onChange={(v) => {
                update("afterimageDamp", v);
                useGameStore.getState().renderer?.setAfterimageDamp(v);
              }}
            />
          </div>
        )}
        <SettingToggle
          label="Bloom"
          value={settings.bloomEnabled}
          onChange={(v) => {
            update("bloomEnabled", v);
            useGameStore.getState().renderer?.setPostProcessEnabled("bloom", v);
          }}
        />
        {settings.bloomEnabled && (
          <>
            <div className="mt-3">
              <SettingSlider
                label="Bloom Threshold"
                value={settings.bloomThreshold}
                min={0} max={2} step={0.05}
                onChange={(v) => {
                  update("bloomThreshold", v);
                  useGameStore.getState().renderer?.setBloomThreshold(v);
                }}
              />
            </div>
            <div className="mt-3">
              <SettingSlider
                label="Bloom Strength"
                value={settings.bloomStrength}
                min={0} max={3} step={0.05}
                onChange={(v) => {
                  update("bloomStrength", v);
                  useGameStore.getState().renderer?.setBloomStrength(v);
                }}
              />
            </div>
          </>
        )}
        <SettingToggle
          label="ASCII Render"
          value={settings.asciiEnabled}
          onChange={(v) => {
            update("asciiEnabled", v);
            useGameStore.getState().renderer?.setPostProcessEnabled("ascii", v);
          }}
        />
        {settings.asciiEnabled && (
          <>
            <div className="mt-3">
              <SettingSlider
                label="Cell Size"
                value={settings.asciiCellSize}
                min={2} max={24} step={1}
                onChange={(v) => {
                  update("asciiCellSize", v);
                  useGameStore.getState().renderer?.setASCIICellSize(v);
                }}
              />
            </div>
            <SettingToggle
              label="Use Color"
              value={settings.asciiUseColor}
              onChange={(v) => {
                update("asciiUseColor", v);
                useGameStore.getState().renderer?.setASCIIUseColor(v);
              }}
            />
          </>
        )}
      </div>
    </>
  );
}

function ControlsTab({ settings, update }: TabProps) {
  const bindings = settings.keybindings as Record<string, string>;

  const setBinding = (action: string, key: string) => {
    update("keybindings", { ...bindings, [action]: key });
  };

  return (
    <>
      <SectionTitle>Controls</SectionTitle>
      <div className="pt-1">
        <div className="text-sm text-ocean-300 mb-2">Mouse Sensitivity</div>
        <SettingSlider
          label="First Person"
          value={settings.firstPersonSensitivity}
          min={0.1} max={3} step={0.1}
          onChange={(v) => {
            update("firstPersonSensitivity", v);
            useGameStore.getState().renderer?.setFirstPersonSensitivity(v);
          }}
        />
        <div className="mt-3">
          <SettingSlider
            label="Third Person"
            value={settings.thirdPersonSensitivity}
            min={0.1} max={3} step={0.1}
            onChange={(v) => {
              update("thirdPersonSensitivity", v);
              useGameStore.getState().renderer?.setThirdPersonSensitivity(v);
            }}
          />
        </div>
        <div className="mt-3">
          <SettingSlider
            label="Freecam"
            value={settings.freecamSensitivity}
            min={0.1} max={3} step={0.1}
            onChange={(v) => {
              update("freecamSensitivity", v);
              useGameStore.getState().renderer?.setFreecamSensitivity(v);
            }}
          />
        </div>
      </div>
      <SettingToggle
        label="Invert Y-Axis"
        value={settings.invertY}
        onChange={(v) => update("invertY", v)}
      />
      <div className="pt-2">
        <div className="text-sm text-ocean-300 mb-2">Key Bindings</div>
        <div className="grid grid-cols-2 gap-3">
          {Object.entries(bindings).map(([action, key]) => (
            <KeyBindRow
              key={action}
              action={action}
              keyChar={key}
              onChange={(k) => setBinding(action, k)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reusable UI primitives
// ---------------------------------------------------------------------------

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-1">
      <h3 className="text-lg font-semibold text-ocean-100">{children}</h3>
      <div className="flex-1 h-px bg-ocean-700/50" />
    </div>
  );
}

function SettingSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  unit?: string;
  format?: (v: number) => string;
}) {
  return (
    <div data-focusable data-control-type="slider">
      <div className="flex justify-between text-sm text-ocean-300 mb-1">
        <span>{label}</span>
        <span>{format ? format(value) : `${value}${unit ?? ""}`}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-ocean-400"
      />
    </div>
  );
}

function SettingSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div data-focusable data-control-type="select">
      <div className="text-sm text-ocean-300 mb-1">{label}</div>
      <select
        className="input-field w-full capitalize"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o} className="capitalize">
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function SettingToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div data-focusable data-control-type="toggle" className="flex items-center justify-between">
      <span className="text-sm text-ocean-300">{label}</span>
      <button
        className={`w-12 h-6 rounded-full transition-colors ${value ? "bg-ocean-500" : "bg-ocean-800"}`}
        onClick={() => onChange(!value)}
      >
        <div
          className={`w-5 h-5 bg-white rounded-full transition-transform ${value ? "translate-x-6" : "translate-x-0.5"}`}
        />
      </button>
    </div>
  );
}

function KeyBindRow({
  action,
  keyChar,
  onChange,
}: {
  action: string;
  keyChar: string;
  onChange: (key: string) => void;
}) {
  const [listening, setListening] = React.useState(false);

  const handleKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setListening(false);
      return;
    }
    onChange(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    setListening(false);
  };

  React.useEffect(() => {
    if (!listening) return;
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [listening]);

  return (
    <div data-focusable data-control-type="keybind" className="flex items-center justify-between bg-ocean-800/50 rounded-lg px-3 py-2">
      <span className="text-sm text-ocean-300 capitalize">{action}</span>
      <button
        data-listening={listening ? "true" : undefined}
        onClick={() => setListening(true)}
        className={`min-w-[3rem] px-3 py-1 rounded text-sm font-mono font-medium transition-colors ${
          listening
            ? "bg-ocean-400 text-ocean-950 animate-pulse"
            : "bg-ocean-700 text-ocean-100 hover:bg-ocean-600"
        }`}
      >
        {listening ? "…" : keyChar}
      </button>
    </div>
  );
}
