import { HeroScanLoop } from "@/components/marketing/hero-scan-loop";

/**
 * Hero illustration.
 *
 * This used to be a blank drawn device, then one still capture of the camera.
 * It now holds the scanning loop, so the first thing on the page shows the
 * product working on a series of real items rather than sitting on one.
 *
 * The device is still a drawing and the screen is still the only real part, but
 * it is drawn as hardware now: a titanium rail, a black bezel inside it, and
 * three side buttons, all proportioned off the reference in marketing.css. The
 * frame draws no notch: the screen fills it edge to edge and carries the app's
 * own status bar, so a drawn notch would land on top of app content. It sat on
 * the Trophy Wall title once. The frame is also square to the page now rather
 * than tilted, because a rotated frame shears the captured chrome inside it.
 */
export function HeroArt({ children }: { children?: React.ReactNode }) {
  return <div className="mkt-hero__art">{children ?? <HeroArtDevice />}</div>;
}

function HeroArtDevice() {
  return (
    <div className="mkt-phone mkt-hero__minimal-phone">
      <span className="mkt-phone__action" aria-hidden="true" />
      <div className="mkt-phone__screen">
        <HeroScanLoop />
      </div>
    </div>
  );
}
