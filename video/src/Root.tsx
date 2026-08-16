import React from "react";
import { Composition } from "remotion";
import { AdLayerVideo } from "./Video";
import { FPS, W, H, TOTAL } from "./theme";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="AdLayerDemo"
    component={AdLayerVideo}
    durationInFrames={TOTAL}
    fps={FPS}
    width={W}
    height={H}
  />
);
