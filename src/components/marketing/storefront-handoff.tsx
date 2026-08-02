import Image from "next/image";

const STOREFRONTS = [
  {
    name: "eBay",
    detail: "Confirm before SnapList publishes to your connected eBay account.",
    state: "Publish after confirmation",
  },
  {
    name: "Facebook Marketplace handoff",
    detail: "SnapList prepares text and photos in the share sheet. You finish the form.",
    state: "Prepared for sharing",
  },
  {
    name: "Mercari handoff",
    detail: "SnapList prepares text and photos in the share sheet. You finish the form.",
    state: "Prepared for sharing",
  },
] as const;

/** Honest three-destination handoff: only eBay is a direct publish path. */
export function StorefrontHandoff() {
  return (
    <section className="mkt-section mkt-storefronts">
      <div className="mkt-shell">
        <div className="mkt-storefronts__intro">
          <h2 className="mkt-h2">One photo, three storefronts.</h2>
          <p>One editable draft, with the destination and your next step made clear.</p>
        </div>
        <div className="mkt-storefronts__grid">
          <div className="mkt-storefronts__photo">
            <Image
              src="/demo/reseller/ps5.webp"
              alt="A PlayStation 5 console with a matching controller"
              fill
              sizes="(max-width: 767px) 100vw, 36vw"
            />
          </div>
          <div className="mkt-storefronts__cards">
            {STOREFRONTS.map((storefront) => (
              <article key={storefront.name} className="mkt-storefront">
                <div>
                  <h3>{storefront.name}</h3>
                  <p>{storefront.detail}</p>
                </div>
                <span>{storefront.state}</span>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
