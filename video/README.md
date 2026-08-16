# AdLayer — 2-minute submission video

Remotion project for the hackathon submission film. 1920x1080, 30fps, 3600 frames (120s).
Every number and quote is sourced from `SUBMISSION.md`, `data/demo/FINDING.md`,
`data/demo/BEFORE-agent-capture.md`, `data/demo/AFTER-agent-capture.md`, and the served
`publishers/darkroom-commons/llms.txt`. Nothing in it is invented.

## Install

```bash
cd video
npm install
```

## Render

```bash
cd video
npx remotion render src/index.ts AdLayerDemo out/adlayer-demo.mp4 --codec=h264 --crf=18 --concurrency=8
```

Output: `video/out/adlayer-demo.mp4`

## Preview / edit

```bash
cd video
npx remotion studio src/index.ts
```

## Single frame (for checking a scene)

```bash
npx remotion still src/index.ts AdLayerDemo still/f2400.png --frame=2400
```

## Scene table

Frames at 30fps. Edit `src/theme.ts` -> `SCENES` to retime; the chrome, progress rule and
scene counter all read from that one table.

| # | scene | frames | seconds |
|---|---|---|---|
| 1 | TITLE | 0–239 | 0–8 |
| 2 | THE PREMISE | 240–659 | 8–22 |
| 3 | THE PLACEMENT | 660–1139 | 22–38 |
| 4 | BEFORE | 1140–1499 | 38–50 |
| 5 | AFTER | 1500–1979 | 50–66 |
| 6 | THE HUMAN DATA | 1980–2639 | 66–88 |
| 7 | THE FAILURE | 2640–3119 | 88–104 |
| 8 | CLOSE | 3120–3599 | 104–120 |

## Files

- `src/theme.ts` — palette, type stack, scene table. Amber `#C2740A` is the colour of a
  warning label; that is deliberate.
- `src/ui.tsx` — `TypeOn`, `CountUp`, `DrawRule`, `Quote`, `Statement`, `Caption`. Numbers
  use tabular figures so digits do not jitter while animating.
- `src/Frame.tsx` — paper ground, grid, persistent chrome (scene counter, timecode,
  progress rule).
- `src/scenes.tsx` — the eight scenes.
- `src/Video.tsx` / `src/Root.tsx` / `src/index.ts` — composition wiring.

No external assets, no web fonts, no network at render time.
