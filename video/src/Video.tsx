import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { C, SCENES } from "./theme";
import { Chrome } from "./Frame";
import {
  SceneTitle,
  ScenePremise,
  ScenePlacement,
  SceneBefore,
  SceneAfter,
  SceneHumans,
  SceneFailure,
  SceneClose,
  SceneLive,
} from "./scenes";

const BY_ID: Record<string, React.FC> = {
  title: SceneTitle,
  premise: ScenePremise,
  placement: ScenePlacement,
  live: SceneLive,
  before: SceneBefore,
  after: SceneAfter,
  humans: SceneHumans,
  failure: SceneFailure,
  close: SceneClose,
};

export const AdLayerVideo: React.FC = () => (
  <AbsoluteFill style={{ background: C.paper }}>
    {SCENES.map((s) => {
      const Comp = BY_ID[s.id];
      return (
        <Sequence key={s.id} from={s.start} durationInFrames={s.dur} name={s.label}>
          <Comp />
        </Sequence>
      );
    })}
    <Chrome />
  </AbsoluteFill>
);
