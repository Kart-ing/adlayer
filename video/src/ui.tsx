import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { C, F, TAB } from "./theme";

const OUT = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Restrained entrance: short fade with a small upward settle. */
export const Reveal: React.FC<{
  at: number;
  dur?: number;
  y?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ at, dur = 18, y = 14, children, style }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [at, at + dur], [0, 1], {
    ...OUT,
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div
      style={{
        opacity: t,
        transform: `translateY(${(1 - t) * y}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** A rule that draws itself left-to-right. */
export const DrawRule: React.FC<{
  at: number;
  dur?: number;
  color?: string;
  height?: number;
  width?: number | string;
}> = ({ at, dur = 26, color = C.amber, height = 2, width = "100%" }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [at, at + dur], [0, 1], {
    ...OUT,
    easing: Easing.inOut(Easing.cubic),
  });
  return (
    <div style={{ width, height }}>
      <div
        style={{
          width: `${t * 100}%`,
          height,
          background: color,
        }}
      />
    </div>
  );
};

export type Token = { text: string; color?: string; weight?: number };

/**
 * Types a token stream on, character by character, with a block caret.
 * Colour survives the reveal so the [SPONSORED] markers read as markers.
 */
export const TypeOn: React.FC<{
  tokens: Token[];
  at: number;
  cps?: number;
  style?: React.CSSProperties;
  caret?: boolean;
}> = ({ tokens, at, cps = 34, style, caret = true }) => {
  const f = useCurrentFrame();
  const total = tokens.reduce((n, t) => n + t.text.length, 0);
  const shown = Math.max(
    0,
    Math.min(total, Math.floor(((f - at) / 30) * cps))
  );
  const done = shown >= total;
  let cursor = 0;
  const out: React.ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const take = Math.max(0, Math.min(tk.text.length, shown - cursor));
    cursor += tk.text.length;
    if (take <= 0) continue;
    out.push(
      <span
        key={i}
        style={{ color: tk.color ?? C.ink, fontWeight: tk.weight ?? 400 }}
      >
        {tk.text.slice(0, take)}
      </span>
    );
  }
  const blink = Math.floor(f / 8) % 2 === 0;
  return (
    <span style={{ whiteSpace: "pre-wrap", ...style }}>
      {out}
      {caret && f >= at && (!done || blink) ? (
        <span
          style={{
            display: "inline-block",
            width: "0.55em",
            height: "1.02em",
            background: done ? C.faint : C.amber,
            transform: "translateY(0.16em)",
            opacity: done && !blink ? 0 : 1,
          }}
        />
      ) : null}
    </span>
  );
};

/** Integer count-up with tabular figures. */
export const CountUp: React.FC<{
  to: number;
  at: number;
  dur?: number;
  suffix?: string;
  style?: React.CSSProperties;
}> = ({ to, at, dur = 34, suffix = "", style }) => {
  const f = useCurrentFrame();
  const v = interpolate(f, [at, at + dur], [0, to], {
    ...OUT,
    easing: Easing.out(Easing.cubic),
  });
  return (
    <span style={{ ...TAB, fontFamily: F.mono, ...style }}>
      {Math.round(v)}
      {suffix}
    </span>
  );
};

/** Small mono eyebrow, letterspaced. */
export const Eyebrow: React.FC<{
  children: React.ReactNode;
  color?: string;
  size?: number;
  style?: React.CSSProperties;
}> = ({ children, color = C.faint, size = 19, style }) => (
  <div
    style={{
      fontFamily: F.mono,
      fontSize: size,
      letterSpacing: "0.22em",
      textTransform: "uppercase",
      color,
      ...style,
    }}
  >
    {children}
  </div>
);

/** A tag chip — BEFORE / AFTER / outcome names. */
export const Chip: React.FC<{
  children: React.ReactNode;
  color: string;
  wash: string;
  size?: number;
}> = ({ children, color, wash, size = 22 }) => (
  <span
    style={{
      fontFamily: F.mono,
      fontSize: size,
      letterSpacing: "0.2em",
      textTransform: "uppercase",
      color,
      background: wash,
      border: `1px solid ${color}`,
      padding: "8px 16px 7px",
      display: "inline-block",
      lineHeight: 1,
    }}
  >
    {children}
  </span>
);

/** Pull-quote: serif, with a coloured spine. */
export const Quote: React.FC<{
  at: number;
  color?: string;
  size?: number;
  children: React.ReactNode;
  width?: number | string;
}> = ({ at, color = C.amber, size = 46, children, width = "100%" }) => {
  const f = useCurrentFrame();
  const g = interpolate(f, [at, at + 30], [0, 1], {
    ...OUT,
    easing: Easing.inOut(Easing.cubic),
  });
  return (
    <div style={{ display: "flex", gap: 34, width }}>
      <div style={{ width: 4, background: C.hair, flexShrink: 0 }}>
        <div style={{ width: 4, height: `${g * 100}%`, background: color }} />
      </div>
      <Reveal at={at + 6} dur={22} y={10}>
        <div
          style={{
            fontFamily: F.serif,
            fontSize: size,
            lineHeight: 1.36,
            color: C.ink,
            fontStyle: "italic",
          }}
        >
          {children}
        </div>
      </Reveal>
    </div>
  );
};

/** Statement type — the research-result voice. */
export const Statement: React.FC<{
  at: number;
  size?: number;
  color?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ at, size = 62, color = C.ink, children, style }) => (
  <Reveal at={at} dur={20} y={16}>
    <div
      style={{
        fontFamily: F.serif,
        fontSize: size,
        lineHeight: 1.2,
        color,
        letterSpacing: "-0.012em",
        ...style,
      }}
    >
      {children}
    </div>
  </Reveal>
);

/** Sans caption — the annotation voice. */
export const Caption: React.FC<{
  at: number;
  size?: number;
  color?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ at, size = 27, color = C.muted, children, style }) => (
  <Reveal at={at} dur={18} y={10}>
    <div
      style={{
        fontFamily: F.sans,
        fontSize: size,
        lineHeight: 1.5,
        color,
        ...style,
      }}
    >
      {children}
    </div>
  </Reveal>
);

/** Inline monospace run inside prose. */
export const M: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color,
}) => (
  <span style={{ fontFamily: F.mono, fontSize: "0.88em", color, ...TAB }}>
    {children}
  </span>
);
