import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        border: "hsl(var(--border))",
        ring: "hsl(var(--ring))",
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        crimson: { DEFAULT: "hsl(var(--crimson))", ink: "hsl(var(--crimson-ink))" },
        slab: "hsl(var(--slab))",
        bone: { DEFAULT: "hsl(var(--foreground))", dim: "hsl(var(--muted-foreground))" },
        tallow: "hsl(var(--tallow))",
        ochre: "hsl(var(--ochre))",
        formalin: "hsl(var(--formalin))",
        verdigris: "hsl(var(--verdigris))",
      },
      fontFamily: {
        display: ["var(--font-display)", "Anton", "sans-serif"],
        sans: ["var(--font-sans)", "Archivo", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: { DEFAULT: "2px", md: "2px", lg: "3px" },
      letterSpacing: { notice: "0.01em", label: "0.08em" },
    },
  },
  plugins: [],
};

export default config;
