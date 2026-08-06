import { downdraft } from "@downdraft/app/renderer";
import { motion } from "framer-motion";
import { Heart, X } from "lucide-react";
import { useGameStore } from "../stores/game-store";

interface CreditEntry {
  name: string;
  author: string;
  license: string;
  url: string;
}

const FONTS: CreditEntry[] = [
  { name: "Wavefont", author: "The Wavefont Project Authors (dy)", license: "OFL-1.1", url: "https://github.com/dy/wavefont" },
  { name: "Linefont", author: "Dmitry Ivanov", license: "OFL-1.1", url: "https://fonts.google.com/specimen/Linefont" },
  { name: "Urbanist", author: "The Urbanist Project Authors (coreyhu)", license: "OFL-1.1", url: "https://github.com/coreyhu/Urbanist" },
  { name: "Special Elite", author: "Astigmatic One Eye Typographic Institute", license: "Apache-2.0", url: "https://fonts.google.com/specimen/Special+Elite" },
  { name: "Montserrat", author: "The Montserrat Project Authors (JulietaUla)", license: "OFL-1.1", url: "https://github.com/JulietaUla/Montserrat" },
  { name: "Doto", author: "The Doto Project Authors (oliverlalan)", license: "OFL-1.1", url: "https://github.com/oliverlalan/Doto" },
];

const LIBRARIES: CreditEntry[] = [
  { name: "Rapier Physics", author: "DimForge", license: "Apache-2.0", url: "https://rapier.rs" },
  { name: "zstd-wasm", author: "bokuweb", license: "MIT", url: "https://github.com/bokuweb/zstd-wasm" },
  { name: "xxhash-wasm", author: "Jordan Harband", license: "MIT", url: "https://github.com/xxhash/xxhash-wasm" },
  { name: "React", author: "Meta Platforms, Inc.", license: "MIT", url: "https://react.dev" },
  { name: "React DOM", author: "Meta Platforms, Inc.", license: "MIT", url: "https://react.dev" },
  { name: "Framer Motion", author: "Matt Perry", license: "MIT", url: "https://www.framer.com/motion" },
  { name: "Zustand", author: "Paul Henschel", license: "MIT", url: "https://github.com/pmndrs/zustand" },
  { name: "fflate", author: "Arjun Barrett", license: "MIT", url: "https://github.com/101arrowz/fflate" },
  { name: "wgpu-matrix", author: "Gregg Tavares", license: "MIT", url: "https://github.com/greggman/wgpu-matrix" },
  { name: "Lucide Icons", author: "Lucide Contributors", license: "ISC", url: "https://lucide.dev" },
  { name: "Fontsource", author: "Fontsource", license: "MIT", url: "https://fontsource.org" },
];

function CreditRow({ entry }: { entry: CreditEntry }) {
  return (
    <div className="flex flex-col py-2 border-b border-ocean-800/40 last:border-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ocean-100 font-medium text-sm">{entry.name}</span>
        <span className="text-ocean-400 text-xs font-mono shrink-0">{entry.license}</span>
      </div>
      <div className="text-ocean-300 text-xs mt-0.5">
        {entry.author}
      </div>
      <a
        href={entry.url}
        onClick={(e) => { e.preventDefault(); downdraft.openExternal(entry.url); }}
        className="text-ocean-500 hover:text-ocean-300 text-xs mt-0.5 transition-colors cursor-pointer"
      >
        {entry.url}
      </a>
    </div>
  );
}

export default function CreditsScreen() {
  const toggle = useGameStore((s) => s.toggleCredits);

  return (
    <div
      className="absolute inset-0 flex items-center justify-center pointer-events-auto bg-ocean-950/80"
      onClick={toggle}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="hud-panel w-[640px] max-w-[90vw] h-[600px] max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ocean-700/50 shrink-0">
          <h2 className="text-xl font-bold text-ocean-100">Credits &amp; Licenses</h2>
          <button
            onClick={toggle}
            className="text-ocean-400 hover:text-ocean-100 transition-colors p-1"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <p className="text-ocean-300 text-sm mb-6">
            To The Ocean is built with the following open-source software. We gratefully
            acknowledge the authors and projects listed below. Full license texts are
            included in the <code className="text-ocean-200">resources/fonts/</code> directory
            of the application bundle.
          </p>

          {/* Fonts */}
          <h3 className="text-ocean-200 font-semibold text-sm uppercase tracking-wide mb-2 mt-4">
            Fonts
          </h3>
          <div className="mb-6">
            {FONTS.map((f) => <CreditRow key={f.name} entry={f} />)}
          </div>

          {/* Libraries */}
          <h3 className="text-ocean-200 font-semibold text-sm uppercase tracking-wide mb-2">
            Libraries &amp; Tools
          </h3>
          <div className="mb-6">
            {LIBRARIES.map((l) => <CreditRow key={l.name} entry={l} />)}
          </div>

          {/* License notes */}
          <div className="text-ocean-400 text-xs space-y-2 mt-6 pt-4 border-t border-ocean-800/50">
            <p>
              <span className="text-ocean-300 font-semibold">OFL-1.1</span> — SIL Open Font
              License 1.1. Fonts may be used, studied, modified, and redistributed freely
              as long as they are not sold by themselves.
            </p>
            <p>
              <span className="text-ocean-300 font-semibold">Apache-2.0</span> — Apache
              License 2.0. Permits use, modification, and distribution with attribution.
            </p>
            <p>
              <span className="text-ocean-300 font-semibold">MIT</span> — MIT License.
              Permits use, modification, and distribution with copyright notice.
            </p>
            <p>
              <span className="text-ocean-300 font-semibold">ISC</span> — ISC License.
              Functionally equivalent to MIT.
            </p>
          </div>

          <div className="flex items-center justify-center gap-2 text-ocean-500 text-xs mt-6 pb-2">
            <Heart size={14} />
            <span>Made with open-source software</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
