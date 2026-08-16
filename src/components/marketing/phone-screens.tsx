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

/**
 * Captured at 1560x3376 and shipped at 1240 wide. The previous 620x1255 files
 * were both the wrong shape and too small: 219px had been cropped off the top,
 * which made them 0.494 rather than a real iPhone's 0.462, and 620 was under
 * half the pixels a Retina screen asks for at this size.
 */
const SHOT_WIDTH = 1240;
const SHOT_HEIGHT = 2683;

/**
 * The explorer screen renders at 268px scaled by --phone-scale, so it is 327px
 * under 880 and 357px above it. The old "288px" hint understated that, and Next
 * served a 279px file into a 357px box which the browser upscaled again for
 * Retina. Every screen on the page was soft.
 */
const SHOT_SIZES = "(max-width: 879px) 330px, 360px";

function Shot({ src, alt, priority = false }: { src: string; alt: string; priority?: boolean }) {
  return (
    <Image
      className="mkt-scr__shot"
      src={src}
      alt={alt}
      width={SHOT_WIDTH}
      height={SHOT_HEIGHT}
      sizes={SHOT_SIZES}
      priority={priority}
    />
  );
}

export function ScanScreen({ priority = false }: { priority?: boolean }) {
  return (
    <Shot
      src="/marketing/screens/scan.webp"
      alt="The SnapList camera pointed at a pair of Air Jordan 3 sneakers standing on their box, with the shutter and the photo library button below it."
      priority={priority}
    />
  );
}

export function PhotoReviewScreen() {
  return (
    <Shot
      src="/marketing/screens/photo-review.webp"
      alt="Photo review showing four of five photos of a sneaker, each one a different angle, the first marked Cover, a tile for adding another, and an empty voice note row offering to add details the photos might miss."
    />
  );
}

export function ListingReviewScreen() {
  return (
    <Shot
      src="/marketing/screens/listing-review.webp"
      alt="Listing review showing the item identified as an Air Jordan 3 Retro in summit white, an editable price of $118, and the three sold matches between $98 and $135 that the price came from."
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
