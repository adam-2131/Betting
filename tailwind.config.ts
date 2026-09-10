import type { Config } from "tailwindcss";

/** Channel-triple CSS vars keep Tailwind's `/opacity` modifiers working. See globals.css. */
const token = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic terminal tokens. Deliberately desaturated so that positive/negative
        // only ever appear where they carry meaning.
        bg: token("--pa-bg"),
        surface: token("--pa-surface"),
        elevated: token("--pa-elevated"),
        line: token("--pa-line"),
        fg: token("--pa-fg"),
        muted: token("--pa-muted"),
        dim: token("--pa-dim"),
        positive: token("--pa-positive"),
        negative: token("--pa-negative"),
        warning: token("--pa-warning"),
        base: {
          950: "#08090c",
          900: "#0a0c10",
          850: "#12151c",
          800: "#171b24",
          750: "#1f242e",
          700: "#242a37",
          600: "#333b4c",
          500: "#4c556a",
          400: "#5a6275",
          300: "#8b93a7",
          200: "#c3c9d8",
          100: "#e6e9ef",
        },
        pos: { DEFAULT: token("--pa-positive"), dim: "#10b981", bg: "rgb(var(--pa-positive) / 0.10)" },
        neg: { DEFAULT: token("--pa-negative"), dim: "#ef4444", bg: "rgb(var(--pa-negative) / 0.10)" },
        warn: { DEFAULT: token("--pa-warning"), dim: "#f59e0b", bg: "rgb(var(--pa-warning) / 0.10)" },
        accent: { DEFAULT: token("--pa-accent"), dim: "#0ea5e9", bg: "rgb(var(--pa-accent) / 0.10)" },
      },
      borderColor: {
        DEFAULT: token("--pa-line"),
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      letterSpacing: {
        caps: "0.12em",
      },
      maxWidth: {
        terminal: "1600px",
      },
    },
  },
  plugins: [],
};

export default config;
