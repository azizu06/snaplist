import Image from "next/image";

/**
 * Marketing phone screens for the feature explorer and the hero.
 *
 * These were hand-drawn divs until real screens existed. They are now captures
 * of the shipping app, which removes a whole class of drift: a drawn screen can
 * claim a control the build does not have, and one of them did (a "3 of 5"
 * counter on the camera the app never shows).
 *
 * Two rules the captures have to keep. Nothing here may show a state the product
 * does not have, and the marketplace screen in particular has to keep reading as
 * an assisted handoff rather than a destination SnapList posts to, which its own
 * "Not shared" rows do. Second, the screen text is now pixels, so the alt text is
 * the accessible version of it and the step copy beside the phone stays the real
 * reading path.
 */

/** Captured at 1560x3380 and shipped at 620 wide, which is 2x the drawn frame. */
const SHOT_WIDTH = 620;
const SHOT_HEIGHT = 1343;

function Shot({ src, alt, priority = false }: { src: string; alt: string; priority?: boolean }) {
  return (
    <Image
      className="mkt-scr__shot"
      src={src}
      alt={alt}
      width={SHOT_WIDTH}
      height={SHOT_HEIGHT}
      sizes="(max-width: 879px) 60vw, 288px"
      priority={priority}
    />
  );
}

export function ScanScreen({ priority = false }: { priority?: boolean }) {
  return (
    <Shot
      src="/marketing/screens/scan.webp"
      alt="The SnapList camera pointed at a pair of sneakers, with the shutter and the photo library button below it."
      priority={priority}
    />
  );
}

export function PhotoReviewScreen() {
  return (
    <Shot
      src="/marketing/screens/photo-review.webp"
      alt="Photo review showing three of five photos with a cover marker, and a voice note of twelve seconds ready to play."
    />
  );
}

export function ListingReviewScreen() {
  return (
    <Shot
      src="/marketing/screens/listing-review.webp"
      alt="Listing review showing an editable title, condition and price of $118, with the sold matches the price came from."
    />
  );
}

export function PublishScreen() {
  return (
    <Shot
      src="/marketing/screens/publish.webp"
      alt="Share to other marketplaces, with Facebook Marketplace, Mercari and Depop each marked Not shared until you post the prepared listing yourself."
    />
  );
}

export function TrophyWallScreen() {
  return (
    <Shot
      src="/marketing/screens/trophy-wall.webp"
      alt="Trophy Wall, a grid of items the seller has run through SnapList."
    />
  );
}
