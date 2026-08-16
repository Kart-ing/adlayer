// AdLayer video — design tokens.
// Amber is the colour of a warning label. That is the point.

export const C = {
  paper: "#F4F6F8",
  ink: "#14181D",
  amber: "#C2740A",
  green: "#1F6F4A",
  red: "#A32B1E",
  muted: "rgba(20,24,29,0.56)",
  faint: "rgba(20,24,29,0.34)",
  rule: "rgba(20,24,29,0.14)",
  hair: "rgba(20,24,29,0.08)",
  amberWash: "rgba(194,116,10,0.10)",
  greenWash: "rgba(31,111,74,0.10)",
  redWash: "rgba(163,43,30,0.10)",
} as const;

export const F = {
  serif: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif`,
  sans: `"Helvetica Neue", Helvetica, Inter, system-ui, -apple-system, Arial, sans-serif`,
  mono: `"SF Mono", "Menlo", "DejaVu Sans Mono", "Courier New", monospace`,
} as const;

// Tabular figures so digits do not jitter while animating.
export const TAB = {
  fontVariantNumeric: "tabular-nums",
  fontFeatureSettings: '"tnum" 1, "lnum" 1',
};

export const FPS = 30;
export const W = 1920;
export const H = 1080;

// Scene table — start frame and duration, 30fps.
export const SCENES = [
  { id: "title", label: "TITLE", start: 0, dur: 235 },
  { id: "premise", label: "THE PREMISE", start: 235, dur: 392 },
  { id: "placement", label: "THE PLACEMENT", start: 627, dur: 470 },
  { id: "live", label: "LIVE CAPTURE", start: 1097, dur: 724 },
  { id: "before", label: "BEFORE", start: 1821, dur: 352 },
  { id: "after", label: "AFTER", start: 2173, dur: 509 },
  { id: "humans", label: "THE HUMAN DATA", start: 2682, dur: 627 },
  { id: "failure", label: "THE FAILURE", start: 3309, dur: 470 },
  { id: "close", label: "CLOSE", start: 3779, dur: 470 },
] as const;

export const TOTAL = 4249; // 141.6s — matched to the ElevenLabs voiceover
