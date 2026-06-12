import React from "react";
import { Composition } from "remotion";
import { HeroDemoVideo } from "./HeroDemoVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="hero-demo"
      component={HeroDemoVideo}
      durationInFrames={330}
      fps={30}
      width={840}
      height={920}
    />
  );
};
