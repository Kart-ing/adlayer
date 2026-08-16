import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import { C, F, TAB } from "./theme";
import { Ground, Stage } from "./Frame";
import {
  Reveal,
  DrawRule,
  TypeOn,
  CountUp,
  Eyebrow,
  Chip,
  Quote,
  Statement,
  Caption,
  M,
  Token,
} from "./ui";

const OUT = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/* ------------------------------------------------------------------ */
/* 1. TITLE                                                            */
/* ------------------------------------------------------------------ */

export const SceneTitle: React.FC = () => (
  <AbsoluteFill>
    <Ground />
    <Stage>
      <div style={{ maxWidth: 1500 }}>
        <Reveal at={8} dur={26} y={22}>
          <div
            style={{
              fontFamily: F.serif,
              fontSize: 168,
              lineHeight: 1,
              letterSpacing: "-0.035em",
              color: C.ink,
            }}
          >
            AdLayer
          </div>
        </Reveal>

        <div style={{ height: 30 }} />
        <DrawRule at={30} dur={30} width={620} height={3} />
        <div style={{ height: 30 }} />

        <Statement at={44} size={54} color={C.muted} style={{ fontStyle: "italic" }}>
          the ad network for the answer layer
        </Statement>

        <div style={{ height: 46 }} />

        <Caption at={72} size={30} color={C.ink} style={{ maxWidth: 1100 }}>
          We sold ad space inside <M color={C.amber}>llms.txt</M> — then measured
          who notices.
        </Caption>

        <div style={{ height: 64 }} />

        <Reveal at={104} dur={20}>
          <Eyebrow color={C.faint} size={18}>
            Zero Human Company Hackathon &#183; 15 Aug 2026 &#183; n=20 human
            study &#183; live placements
          </Eyebrow>
        </Reveal>
      </div>
    </Stage>
  </AbsoluteFill>
);

/* ------------------------------------------------------------------ */
/* 2. THE PREMISE                                                      */
/* ------------------------------------------------------------------ */

const FileLine: React.FC<{
  at: number;
  children: React.ReactNode;
  color?: string;
  size?: number;
  style?: React.CSSProperties;
}> = ({ at, children, color = C.muted, size = 20, style }) => (
  <Reveal at={at} dur={12} y={6}>
    <div
      style={{
        fontFamily: F.mono,
        fontSize: size,
        lineHeight: 1.7,
        color,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        ...style,
      }}
    >
      {children}
    </div>
  </Reveal>
);

export const ScenePremise: React.FC = () => {
  const f = useCurrentFrame();
  const glow = interpolate(f, [190, 230], [0, 1], OUT);
  return (
    <AbsoluteFill>
      <Ground />
      <Stage style={{ justifyContent: "center" }}>
        <div style={{ display: "flex", gap: 90, alignItems: "center" }}>
          {/* left: the claim */}
          <div style={{ width: 880, flexShrink: 0 }}>
            <Eyebrow style={{ marginBottom: 30 }}>The premise</Eyebrow>
            <Statement at={10} size={64}>
              Agents are becoming
              <br />
              the traffic.
            </Statement>
            <div style={{ height: 22 }} />
            <Statement at={46} size={64}>
              Agents read <M color={C.ink}>llms.txt</M>.
            </Statement>
            <div style={{ height: 44 }} />
            <DrawRule at={96} dur={26} width={360} height={2} />
            <div style={{ height: 30 }} />
            <Statement at={112} size={58} color={C.amber}>
              Nobody had priced
              <br />
              that inventory.
            </Statement>
            <div style={{ height: 40 }} />
            <Caption at={250} size={26} style={{ maxWidth: 760 }}>
              A fresh agent used the file as its site map, unprompted — the
              shakiest assumption in the thesis, now measured.
            </Caption>
          </div>

          {/* right: the file */}
          <Reveal at={26} dur={26} y={20}>
            <div
              style={{
                width: 740,
                background: "#FFFFFF",
                border: `1px solid ${C.rule}`,
                boxShadow: "0 24px 60px rgba(20,24,29,0.07)",
              }}
            >
              <div
                style={{
                  borderBottom: `1px solid ${C.rule}`,
                  padding: "14px 22px",
                  display: "flex",
                  justifyContent: "space-between",
                  fontFamily: F.mono,
                  fontSize: 16,
                  letterSpacing: "0.18em",
                  color: C.faint,
                  ...TAB,
                }}
              >
                <span>/llms.txt</span>
                <span>adlayer-darkroom-commons.onrender.com</span>
              </div>
              <div style={{ padding: "26px 26px 30px" }}>
                <FileLine at={40} color={C.ink} size={22}># Darkroom Commons</FileLine>
                <FileLine at={50}>&nbsp;</FileLine>
                <FileLine at={56}>## Operations</FileLine>
                <FileLine at={64}>- [Chemistry management](/chemistry.html)</FileLine>
                <FileLine at={72}>- [Ventilation and safety](/ventilation…)</FileLine>
                <FileLine at={80}>- [Silver-bearing waste](/silver-and-waste…)</FileLine>
                <FileLine at={88}>- [Shared-space workflow](/shared-workflow…)</FileLine>
                <FileLine at={96}>&nbsp;</FileLine>
                <FileLine at={100}>## About</FileLine>
                <FileLine at={108}>- [Darkroom Commons home](/)</FileLine>
                <FileLine at={116}>&nbsp;</FileLine>

                <div
                  style={{
                    marginTop: 14,
                    padding: "16px 18px",
                    background: `rgba(194,116,10,${0.06 + glow * 0.08})`,
                    borderLeft: `3px solid ${C.amber}`,
                  }}
                >
                  <FileLine at={128} color={C.amber} size={24}>
                    ## Sponsored
                  </FileLine>
                  <FileLine at={148} color={C.faint} size={18}>
                    &lt;!-- entries below are paid placements --&gt;
                  </FileLine>
                  <FileLine at={166} color={C.faint} size={19}>
                    &lt;!-- ADLAYER_SLOT --&gt;
                  </FileLine>
                </div>

                <FileLine at={200} color={C.faint} size={18} style={{ marginTop: 16 }}>
                  &#9633; empty. unpriced. unmeasured.
                </FileLine>
              </div>
            </div>
          </Reveal>
        </div>
      </Stage>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------------------------ */
/* 3. THE PLACEMENT — the real served block                            */
/* ------------------------------------------------------------------ */

const blockTokens: Token[] = [
  { text: "- [", color: C.faint },
  { text: "[SPONSORED]", color: C.amber, weight: 700 },
  { text: " AeroFlow Darkroom Fans", color: C.ink, weight: 600 },
  { text: "](", color: C.faint },
  { text: "https://aeroflow.example/darkroom", color: C.ink },
  { text: "): ", color: C.faint },
  { text: "[SPONSORED]", color: C.amber, weight: 700 },
  { text: " Light-tight inline fans rated for small darkrooms.", color: C.ink },
];

export const ScenePlacement: React.FC = () => (
  <AbsoluteFill>
    <Ground />
    <Stage>
      <Eyebrow style={{ marginBottom: 26 }}>
        The placement &#183; served, verbatim
      </Eyebrow>

      <Reveal at={6} dur={22} y={16}>
        <div
          style={{
            background: "#FFFFFF",
            border: `1px solid ${C.rule}`,
            borderLeft: `4px solid ${C.amber}`,
            boxShadow: "0 24px 60px rgba(20,24,29,0.07)",
            padding: "40px 46px 44px",
          }}
        >
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 20,
              letterSpacing: "0.2em",
              color: C.faint,
              marginBottom: 26,
              ...TAB,
            }}
          >
            /llms.txt &#183; ## Sponsored
          </div>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 38,
              lineHeight: 1.62,
              ...TAB,
            }}
          >
            <TypeOn tokens={blockTokens} at={24} cps={40} />
          </div>
          <div style={{ height: 34 }} />
          <Reveal at={190} dur={18}>
            <div
              style={{
                borderTop: `1px solid ${C.hair}`,
                paddingTop: 20,
                fontFamily: F.mono,
                fontSize: 19,
                color: C.faint,
                letterSpacing: "0.06em",
                ...TAB,
              }}
            >
              ad_id=ad_aeroflow &#183; plc_ea965e92824bd021 &#183; served
              2026-08-15T22:43:27Z &#183; sig=3f47e457d119debf (HMAC)
            </div>
          </Reveal>
        </div>
      </Reveal>

      <div style={{ height: 50 }} />

      <div style={{ display: "flex", gap: 60, alignItems: "flex-start" }}>
        <Caption at={230} size={30} color={C.ink} style={{ maxWidth: 900 }}>
          Disclosure enforced in code.{" "}
          <M color={C.amber}>assertDisclosed()</M> throws before any write.
          <br />
          <span style={{ color: C.muted }}>No flag disables it.</span>
        </Caption>
        <Reveal at={280} dur={20}>
          <div style={{ maxWidth: 640 }}>
            <div
              style={{
                fontFamily: F.serif,
                fontSize: 27,
                fontStyle: "italic",
                lineHeight: 1.42,
                color: C.muted,
              }}
            >
              Disclosed paid placement is advertising. Undisclosed content
              engineered to steer agents is prompt injection. We build the first
              and never the second.
            </div>
          </div>
        </Reveal>
      </div>
    </Stage>
  </AbsoluteFill>
);

/* ------------------------------------------------------------------ */
/* 4. BEFORE                                                           */
/* ------------------------------------------------------------------ */

export const SceneBefore: React.FC = () => (
  <AbsoluteFill>
    <Ground />
    <Stage>
      <Reveal at={0} dur={16}>
        <Chip color={C.muted} wash="rgba(20,24,29,0.04)">
          Before &#183; slot empty
        </Chip>
      </Reveal>
      <div style={{ height: 34 }} />
      <Statement at={14} size={56} style={{ maxWidth: 1400 }}>
        We pointed a fresh AI at the site — before serving.
      </Statement>
      <div style={{ height: 54 }} />
      <Quote at={62} color={C.muted} size={52} width={1560}>
        “that slot is <strong style={{ fontStyle: "normal" }}>currently
        empty</strong> — I fetched it repeatedly, including as ClaudeBot”
      </Quote>
      <div style={{ height: 44 }} />
      <Caption at={150} size={30} color={C.ink}>
        It named no brands at all.
      </Caption>
      <div style={{ height: 18 }} />
      <Caption at={186} size={25}>
        Verbatim: “this site names no products and no brands, anywhere.” The
        control is the agent&#8217;s own report.
      </Caption>
    </Stage>
  </AbsoluteFill>
);

/* ------------------------------------------------------------------ */
/* 5. AFTER                                                            */
/* ------------------------------------------------------------------ */

export const SceneAfter: React.FC = () => (
  <AbsoluteFill>
    <Ground />
    <Stage>
      <Reveal at={0} dur={16}>
        <Chip color={C.green} wash={C.greenWash}>
          After &#183; surfaced_labeled
        </Chip>
      </Reveal>
      <div style={{ height: 34 }} />
      <Statement at={14} size={54} style={{ maxWidth: 1500 }}>
        Same agent. Same question.
        <br />
        One line of <M color={C.amber}>llms.txt</M> different.
      </Statement>
      <div style={{ height: 52 }} />
      <Quote at={78} color={C.green} size={50} width={1600}>
        “I am not recommending AeroFlow. Passing it to you as advice would be
        laundering a paid placement into a recommendation.”
      </Quote>
      <div style={{ height: 46 }} />
      <Caption at={230} size={30} color={C.ink}>
        The label survived — and changed the model&#8217;s behaviour.
      </Caption>
      <div style={{ height: 16 }} />
      <Caption at={280} size={25}>
        It read back every disclosure element we render: the tag, the notice,
        and the provenance <M>ad_id</M>.
      </Caption>
    </Stage>
  </AbsoluteFill>
);

/* ------------------------------------------------------------------ */
/* 6. THE HUMAN DATA — centrepiece                                     */
/* ------------------------------------------------------------------ */

const Bar: React.FC<{
  at: number;
  name: string;
  pct: number;
  count: string;
  color: string;
  wash: string;
}> = ({ at, name, pct, count, color, wash }) => {
  const f = useCurrentFrame();
  const g = interpolate(f, [at, at + 38], [0, 1], {
    ...OUT,
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <div
        style={{
          width: 168,
          flexShrink: 0,
          fontFamily: F.mono,
          fontSize: 19,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color,
          textAlign: "right",
        }}
      >
        {name}
      </div>
      <div style={{ flex: 1, height: 40, background: wash, position: "relative" }}>
        <div
          style={{
            width: `${g * pct}%`,
            height: 40,
            background: color,
          }}
        />
      </div>
      <div
        style={{
          width: 190,
          flexShrink: 0,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "flex-end",
          gap: 12,
        }}
      >
        <CountUp
          to={pct}
          at={at}
          dur={38}
          suffix="%"
          style={{ fontSize: 50, color, letterSpacing: "-0.02em" }}
        />
        <Reveal at={at + 30} dur={14} y={4}>
          <span
            style={{
              fontFamily: F.mono,
              fontSize: 21,
              color: C.faint,
              ...TAB,
            }}
          >
            {count}
          </span>
        </Reveal>
      </div>
    </div>
  );
};

const Panel: React.FC<{
  at: number;
  title: string;
  rows: React.ReactNode;
}> = ({ at, title, rows }) => (
  <div style={{ flex: 1 }}>
    <Reveal at={at} dur={16}>
      <Eyebrow color={C.ink} size={21}>
        {title}
      </Eyebrow>
    </Reveal>
    <div style={{ height: 14 }} />
    <DrawRule at={at + 4} dur={22} color={C.rule} height={1} />
    <div style={{ height: 30 }} />
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      {rows}
    </div>
  </div>
);

export const SceneHumans: React.FC = () => (
  <AbsoluteFill>
    <Ground />
    <Stage style={{ justifyContent: "flex-start", paddingTop: 132 }}>
      <Eyebrow style={{ marginBottom: 22 }}>
        The human data &#183; Terac &#183; three blind arms
      </Eyebrow>
      <Statement at={8} size={54} style={{ maxWidth: 1560 }}>
        We paid <M color={C.ink}>20</M> real people to read an AI answer.
      </Statement>
      <div style={{ height: 14 }} />
      <Caption at={40} size={26}>
        Identical copy in every arm. The only difference is the{" "}
        <M color={C.amber}>[SPONSORED]</M> label.
      </Caption>

      <div style={{ height: 62 }} />

      <div style={{ display: "flex", gap: 96 }}>
        <Panel
          at={70}
          title="Recognised the ad"
          rows={
            <>
              <Bar
                at={92}
                name="labelled"
                pct={100}
                count="15/15"
                color={C.amber}
                wash={C.amberWash}
              />
              <Bar
                at={124}
                name="unlabelled"
                pct={20}
                count="1/5"
                color={C.ink}
                wash="rgba(20,24,29,0.07)"
              />
            </>
          }
        />
        <Panel
          at={186}
          title="Would trust it"
          rows={
            <>
              <Bar
                at={208}
                name="labelled"
                pct={27}
                count="4/15"
                color={C.amber}
                wash={C.amberWash}
              />
              <Bar
                at={240}
                name="unlabelled"
                pct={60}
                count="3/5"
                color={C.ink}
                wash="rgba(20,24,29,0.07)"
              />
            </>
          }
        />
      </div>

      <div style={{ height: 56 }} />
      <Caption at={330} size={27} style={{ maxWidth: 1600 }}>
        Every person shown the label spotted the ad. Four in five shown
        identical copy without it did not — and trusted the assistant more than
        twice as much.
      </Caption>

      <div style={{ height: 46 }} />
      <DrawRule at={396} dur={30} width={1728} height={2} />
      <div style={{ height: 34 }} />
      <Statement at={416} size={62} color={C.amber} style={{ maxWidth: 1700 }}>
        Hiding the ad makes it more effective <em>and</em> better liked.
      </Statement>
      <div style={{ height: 22 }} />
      <Caption at={486} size={26}>
        The incentive runs away from honesty. So disclosure cannot be left to
        whoever profits from omitting it.
      </Caption>
    </Stage>
  </AbsoluteFill>
);

/* ------------------------------------------------------------------ */
/* 7. THE FAILURE                                                      */
/* ------------------------------------------------------------------ */

const Outcome: React.FC<{
  at: number;
  n: string;
  name: string;
  desc: string;
  color: string;
  wash: string;
  active?: boolean;
}> = ({ at, n, name, desc, color, wash, active }) => {
  const f = useCurrentFrame();
  const hi = active
    ? interpolate(f, [at + 30, at + 60], [0, 1], OUT)
    : 0;
  return (
    <Reveal at={at} dur={16} y={10}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 28,
          padding: "16px 22px",
          background: active ? `rgba(194,116,10,${0.05 + hi * 0.07})` : "transparent",
          borderLeft: `3px solid ${active ? color : C.hair}`,
        }}
      >
        <span
          style={{
            fontFamily: F.mono,
            fontSize: 20,
            color: C.faint,
            width: 34,
            ...TAB,
          }}
        >
          {n}
        </span>
        <span
          style={{
            fontFamily: F.mono,
            fontSize: 24,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color,
            background: wash,
            border: `1px solid ${color}`,
            padding: "9px 15px 8px",
            lineHeight: 1,
            width: 400,
            flexShrink: 0,
            textAlign: "center",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontFamily: F.sans,
            fontSize: 27,
            color: active ? C.ink : C.muted,
          }}
        >
          {desc}
        </span>
      </div>
    </Reveal>
  );
};

export const SceneFailure: React.FC = () => (
  <AbsoluteFill>
    <Ground />
    <Stage style={{ justifyContent: "flex-start", paddingTop: 132 }}>
      <Statement at={0} size={58}>
        But the label doesn&#8217;t always survive.
      </Statement>
      <div style={{ height: 14 }} />
      <Caption at={26} size={25}>
        Same ad, same site, same model — four different outcomes.
      </Caption>
      <div style={{ height: 40 }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Outcome
          at={54}
          n="01"
          name="Refused"
          desc="declined to pass the paid placement on at all"
          color={C.green}
          wash={C.greenWash}
        />
        <Outcome
          at={82}
          n="02"
          name="Disclosed"
          desc="named it, and marked it as advertising rather than endorsement"
          color={C.green}
          wash={C.greenWash}
        />
        <Outcome
          at={110}
          n="03"
          name="Label as decoration"
          desc="the one nobody measures"
          color={C.amber}
          wash={C.amberWash}
          active
        />
        <Outcome
          at={152}
          n="04"
          name="Stripped"
          desc="brand named, no label at all"
          color={C.red}
          wash={C.redWash}
        />
      </div>

      <div style={{ height: 46 }} />
      <Quote at={200} color={C.amber} size={44} width={1560}>
        “I&#8217;d <strong style={{ fontStyle: "normal" }}>prioritize</strong> …
        the site&#8217;s <strong style={{ fontStyle: "normal" }}>sponsored</strong>{" "}
        listing for AeroFlow”
      </Quote>

      <div style={{ height: 40 }} />
      <Caption at={310} size={30} color={C.ink}>
        Word present. Recommendation given anyway.
      </Caption>
      <div style={{ height: 14 }} />
      <Caption at={352} size={27}>
        Label survival ran <M color={C.red}>60&#8211;83%</M> across batches. We
        report the range, not the flattering end of it.
      </Caption>
    </Stage>
  </AbsoluteFill>
);

/* ------------------------------------------------------------------ */
/* 8. CLOSE                                                            */
/* ------------------------------------------------------------------ */

export const SceneClose: React.FC = () => (
  <AbsoluteFill>
    <Ground />
    <Stage>
      <Statement at={0} size={76} style={{ maxWidth: 1620 }}>
        A label that works most of the time is not a standard.
      </Statement>
      <div style={{ height: 44 }} />
      <Statement at={60} size={44} color={C.muted} style={{ maxWidth: 1500 }}>
        That&#8217;s why disclosure lives in the serving path, not a policy doc.
      </Statement>

      <div style={{ height: 52 }} />
      <DrawRule at={130} dur={28} width={520} height={2} />
      <div style={{ height: 36 }} />

      <Statement at={152} size={50} color={C.amber} style={{ maxWidth: 1500 }}>
        Next: a consented channel, gated by the buyer&#8217;s own agent.
      </Statement>

      <div style={{ height: 74 }} />

      <Reveal at={250} dur={24} y={14}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 34,
            borderTop: `1px solid ${C.rule}`,
            paddingTop: 34,
          }}
        >
          <span
            style={{
              fontFamily: F.serif,
              fontSize: 62,
              letterSpacing: "-0.03em",
              color: C.ink,
            }}
          >
            AdLayer
          </span>
          <span
            style={{
              fontFamily: F.mono,
              fontSize: 34,
              color: C.amber,
              letterSpacing: "0.02em",
            }}
          >
            github.com/Kart-ing/adlayer
          </span>
        </div>
      </Reveal>

      <div style={{ height: 34 }} />
      <Reveal at={310} dur={20}>
        <Eyebrow size={18}>
          676 tests &#183; 20 red-team findings fixed &#183; disclosure enforced
          in the serving path
        </Eyebrow>
      </Reveal>
    </Stage>
  </AbsoluteFill>
);
