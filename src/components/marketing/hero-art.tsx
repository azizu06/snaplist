import { ScanScreen } from "@/components/marketing/phone-screens";

/**
 * Hero illustration.
 *
 * This used to be a blank drawn device, with a note to swap in a real image of
 * the scanning feature once one existed. That image exists now, so the hero
 * shows the camera the app actually opens on rather than an empty rectangle.
 *
 * The device is still a drawing and the screen is still the only real part. The
 * frame no longer draws a notch: every shot is cropped just below the status bar
 * and fills the screen edge to edge, so a drawn notch would land on top of app
 * content rather than in empty status-bar space. It sat on the Trophy Wall title.
 */
export function HeroArt({ children }: { children?: React.ReactNode }) {
  return <div className="mkt-hero__art">{children ?? <HeroArtDevice />}</div>;
}

function HeroArtDevice() {
  return (
    <div className="mkt-phone mkt-hero__minimal-phone">
      <div className="mkt-phone__screen">
        <ScanScreen priority />
      </div>
    </div>
  );
}
