/**
 * Hero illustration.
 *
 * v6 draws two arrangements: above 880 a dark Scan frame tilted behind a light
 * Listing Review frame, below 880 the Listing Review frame alone. Both branches
 * are in the DOM and one is `display: none`, which also removes it from the
 * accessibility tree — so a screen reader is never offered the same illustration
 * twice. The frames are decorative drawings; the copy beside them carries the
 * meaning, and the `Illustrative` chip says what they are.
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
    <>
      <div className="mkt-hero__pair">
        <div className="mkt-hero__pair-back">
          <ScanFrame />
        </div>
        <div className="mkt-hero__pair-front">
          <ListingFrame />
        </div>
      </div>
      <div className="mkt-hero__single">
        <ListingFrame />
      </div>
    </>
  );
}

function ScanFrame() {
  return (
    <div className="mkt-phone mkt-hero__sp" aria-hidden="true">
      <span className="mkt-phone__notch" />
      <div className="mkt-phone__screen">
        <div className="mkt-hero__sbar">
          <span>Scan</span>
          <span className="mkt-hero__scount">3 of 5</span>
        </div>
        <div className="mkt-hero__sview" />
        <div className="mkt-hero__sstrip">
          <div className="mkt-hero__sthumb" />
          <div className="mkt-hero__sthumb" />
          <div className="mkt-hero__sthumb" />
        </div>
        <div className="mkt-hero__sshutter-row">
          <div className="mkt-hero__sshutter" />
        </div>
      </div>
    </div>
  );
}

function ListingFrame() {
  return (
    <div className="mkt-phone mkt-hero__lp" aria-hidden="true">
      <span className="mkt-phone__notch" />
      <span className="mkt-phone__chip">Illustrative</span>
      <div className="mkt-phone__screen">
        <div className="mkt-hero__lbar">
          <span>Listing Review</span>
          <span className="mkt-scr__pill">Draft</span>
        </div>
        <div className="mkt-hero__lbody">
          <div className="mkt-scr__field">
            <div className="mkt-scr__label">Title</div>
            <div className="mkt-scr__value">Wool blend scarf, gray</div>
          </div>
          <div className="mkt-scr__row">
            <div className="mkt-scr__field">
              <div className="mkt-scr__label">Condition</div>
              <div className="mkt-scr__value">Used, good</div>
            </div>
            <div className="mkt-scr__field">
              <div className="mkt-scr__label">Specifics</div>
              <div className="mkt-scr__value">One size</div>
            </div>
          </div>
          {/* The hero shows the no-evidence case on purpose: the pricing router
              cannot promise comps, and a hero that always finds them would be
              the page's least honest claim. */}
          <div className="mkt-scr__field mkt-scr__field--filled">
            <div className="mkt-scr__label">Price</div>
            <div className="mkt-scr__value">No sold matches found. You set the price.</div>
          </div>
        </div>
        <div className="mkt-scr__cta">Confirm listing</div>
      </div>
    </div>
  );
}
