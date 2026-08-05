/**
 * Hero illustration.
 *
 * The phone is a neutral, decorative device treatment. Product details remain in
 * the feature explorer instead of turning the hero into an invented app screen.
 */
export function HeroArt({ children }: { children?: React.ReactNode }) {
  return (
    <div className="mkt-hero__art">
      {/* Placeholder seam: replace this drawing with an approved iPhone image
          that shows the in-app scanning feature when that asset is ready. */}
      {children ?? <HeroArtPlaceholder />}
    </div>
  );
}

function HeroArtPlaceholder() {
  return (
    <div className="mkt-phone mkt-hero__minimal-phone" aria-hidden="true">
      <span className="mkt-phone__notch" />
      <div className="mkt-phone__screen mkt-hero__neutral-screen" />
    </div>
  );
}
