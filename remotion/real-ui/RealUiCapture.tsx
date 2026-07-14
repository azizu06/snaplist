import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const REAL_UI_CAPTURE_LEN = 180;

export type RealUiSurface =
  | "snap"
  | "identify"
  | "price"
  | "write"
  | "publish"
  | "buyer-qa"
  | "inbox-qa";

export type RealUiCaptureProps = {
  surface: RealUiSurface;
  formFactor: "desktop" | "mobile";
  theme?: "light" | "dark";
};

const SHOTS: Record<RealUiSurface, string[]> = {
  snap: ["upload"],
  identify: ["review-identify"],
  price: ["review-price"],
  write: ["review-write"],
  publish: ["publish-draft", "publish-live"],
  "buyer-qa": ["inbox-list", "inbox-draft", "inbox-sent"],
  "inbox-qa": ["inbox-list", "inbox-draft", "inbox-sent"],
};

function CaptureFrame({
  shot,
  formFactor,
  theme,
  opacity,
  scale,
}: {
  shot: string;
  formFactor: RealUiCaptureProps["formFactor"];
  theme: NonNullable<RealUiCaptureProps["theme"]>;
  opacity: number;
  scale: number;
}) {
  return (
    <Img
      src={staticFile(`demo/captures/${formFactor}/${theme}/${shot}.png`)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: "50% 50%",
      }}
    />
  );
}

/**
 * A deliberately thin animation layer over screenshots of the real app. The
 * underlying pixels come from `/dev/preview/*`, which mounts the shipped views
 * and components with deterministic fixtures. Multi-state stories crossfade
 * between real screens; single-state stories use a gentle loop-safe push-in.
 */
export const RealUiCapture: React.FC<RealUiCaptureProps> = ({
  surface,
  formFactor,
  theme = "light",
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const shots = SHOTS[surface];
  const segment = durationInFrames / shots.length;
  const activeIndex = Math.min(shots.length - 1, Math.floor(frame / segment));
  const nextIndex = (activeIndex + 1) % shots.length;
  const local = frame - activeIndex * segment;
  const fadeFrames = Math.min(18, segment * 0.22);
  const nextOpacity =
    shots.length === 1
      ? 0
      : interpolate(local, [segment - fadeFrames, segment], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const loopProgress = frame / Math.max(1, durationInFrames - 1);
  const scale = 1 + 0.014 * ((1 - Math.cos(loopProgress * Math.PI * 2)) / 2);

  return (
    <AbsoluteFill style={{ backgroundColor: theme === "dark" ? "#141414" : "#f6f6f7" }}>
      <CaptureFrame
        shot={shots[activeIndex]}
        formFactor={formFactor}
        theme={theme}
        opacity={1}
        scale={scale}
      />
      {shots.length > 1 ? (
        <CaptureFrame
          shot={shots[nextIndex]}
          formFactor={formFactor}
          theme={theme}
          opacity={nextOpacity}
          scale={scale}
        />
      ) : null}
    </AbsoluteFill>
  );
};
