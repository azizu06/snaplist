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
  // The photo is added through UploadView's real file input between these two
  // states; Remotion only crossfades the genuine browser captures.
  snap: ["upload-empty", "upload-filled"],
  identify: ["review-identify"],
  price: ["review-price"],
  write: ["review-write"],
  publish: ["publish-draft", "publish-live"],
  // The Guide's Answer step starts on the drafted response itself. The in-app
  // inbox teaser stays on the legible draft → sent conversation, rather than
  // spending time on a dense desktop-wide list view.
  "buyer-qa": ["inbox-draft", "inbox-sent"],
  "inbox-qa": ["inbox-draft", "inbox-sent"],
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
  const mobileObjectPosition: Record<string, string> = {
    // The inbox is a full-height application surface. Aim each 6:5 crop at the
    // real interaction instead of letting a generic center crop land on the
    // intentionally quiet space between the thread and its composer.
    "inbox-list": "50% 24%",
    "inbox-draft": "50% 100%",
    "inbox-sent": "50% 30%",
  };

  return (
    <Img
      src={staticFile(`demo/captures/${formFactor}/${theme}/${shot}.png`)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        objectPosition:
          formFactor === "mobile" ? (mobileObjectPosition[shot] ?? "50% 50%") : "50% 50%",
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
 * Mobile compositions crop the full 390×844 browser capture around the
 * focused action instead of shrinking a dense phone screen into the slot.
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
