import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { C, F, TAB, SCENES, TOTAL, FPS } from "./theme";

/** Paper ground with a faint engineering grid — an instrument, not a slide. */
export const Ground: React.FC = () => (
  <AbsoluteFill style={{ background: C.paper }}>
    <AbsoluteFill
      style={{
        backgroundImage: `linear-gradient(${C.hair} 1px, transparent 1px),
                          linear-gradient(90deg, ${C.hair} 1px, transparent 1px)`,
        backgroundSize: "120px 120px",
        opacity: 0.5,
      }}
    />
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,0.85), rgba(255,255,255,0) 70%)",
      }}
    />
  </AbsoluteFill>
);

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Persistent chrome: run label, scene index, elapsed timecode, progress rule. */
export const Chrome: React.FC = () => {
  const f = useCurrentFrame();
  const idx = Math.max(
    0,
    SCENES.findIndex((s, i) => {
      const next = SCENES[i + 1];
      return f >= s.start && (!next || f < next.start);
    })
  );
  const scene = SCENES[idx];
  const secs = Math.floor(f / FPS);
  const tc = `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`;
  const prog = interpolate(f, [0, TOTAL], [0, 1], {
    extrapolateRight: "clamp",
  });
  const fade = interpolate(f, [0, 24], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ opacity: fade, pointerEvents: "none" }}>
      {/* top rule */}
      <div
        style={{
          position: "absolute",
          top: 56,
          left: 96,
          right: 96,
          height: 1,
          background: C.rule,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 24,
          left: 96,
          right: 96,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontFamily: F.mono,
          fontSize: 17,
          letterSpacing: "0.24em",
          color: C.faint,
          ...TAB,
        }}
      >
        <div>
          <span style={{ color: C.amber }}>&#9632;</span>{" "}
          <span style={{ color: C.ink }}>ADLAYER</span>
          <span style={{ color: C.faint }}> / MEASUREMENT REPORT</span>
        </div>
        <div>
          {scene.label}
          <span style={{ color: C.rule }}> &#183; </span>
          SCENE {pad2(idx + 1)}/{pad2(SCENES.length)}
          <span style={{ color: C.rule }}> &#183; </span>
          {tc}
        </div>
      </div>

      {/* bottom progress */}
      <div
        style={{
          position: "absolute",
          bottom: 52,
          left: 96,
          right: 96,
          height: 2,
          background: C.hair,
        }}
      >
        <div
          style={{ width: `${prog * 100}%`, height: 2, background: C.amber }}
        />
        {SCENES.map((s) => (
          <div
            key={s.id}
            style={{
              position: "absolute",
              left: `${(s.start / TOTAL) * 100}%`,
              top: -4,
              width: 1,
              height: 10,
              background: C.rule,
            }}
          />
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** Standard content box, inset from the chrome. */
export const Stage: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <AbsoluteFill
    style={{
      padding: "140px 96px 120px",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      ...style,
    }}
  >
    {children}
  </AbsoluteFill>
);
