/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./packages/app/index.html",
    "./packages/app/src/renderer/**/*.{js,ts,jsx,tsx}",
    "./games/*/index.html",
    "./games/*/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ocean: {
          50: "#e6f7ff",
          100: "#b3e5fc",
          200: "#81d4fa",
          300: "#4fc3f7",
          400: "#29b6f6",
          500: "#0288d1",
          600: "#0277bd",
          700: "#01579b",
          800: "#003c6e",
          900: "#002a4d",
          950: "#001a33",
        },
        sand: {
          50: "#fff8e1",
          100: "#ffecb3",
          200: "#ffe082",
          300: "#ffd54f",
          400: "#ffca28",
          500: "#ffc107",
        },
        coral: {
          400: "#ff8a80",
          500: "#ff5252",
          600: "#e53935",
        },
        biome: {
          safe: "#4ade80",
          moderate: "#facc15",
          danger: "#f87171",
          extreme: "#7f1d1d",
        },
      },
      fontFamily: {
        body: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
        wavefont: ["Wavefont", "monospace"],
        linefont: ["Linefont", "monospace"],
        urbanist: ["Urbanist", "sans-serif"],
        "special-elite": ["Special Elite", "monospace"],
        montserrat: ["Montserrat", "sans-serif"],
        doto: ["Doto", "monospace"],
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-in-out",
        "slide-up": "slideUp 0.3s ease-out",
        "pulse-slow": "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { transform: "translateY(20px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
