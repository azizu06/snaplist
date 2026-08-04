import type { Metadata } from "next";
import { Faq } from "@/components/marketing/faq";
import { FeatureExplorer } from "@/components/marketing/feature-explorer";
import { HeroArt } from "@/components/marketing/hero-art";
import { MarketingBento } from "@/components/marketing/marketing-bento";
import { MarketplaceLoop } from "@/components/marketing/marketplace-loop";
import { WaitlistForm } from "@/components/marketing/waitlist-form";
import {
  FAQ_TITLE,
  FEATURES_TITLE,
  HERO,
  LOOP_TITLE,
  WHY,
} from "@/lib/marketing/site";

/**
 * SnapList landing page (issue #191, implementing Claude Design v6).
 *
 * The landing page is a scroll with in-page feature and FAQ anchors plus the
 * waitlist-first conversion path. It has no signed-in destinations: the
 * launch client is the iOS app, not a web product.
 *
 * All copy lives in `src/lib/marketing/site.ts` so the honesty test can derive
 * its assertions from product capability rather than from pinned sentences.
 */
export const metadata: Metadata = {
  title: "SnapList — turn photos into a listing you approve",
  description: HERO.title,
};

export default function LandingPage() {
  return (
    <>
      <section className="mkt-hero">
        <div className="mkt-shell">
          <div className="mkt-hero__grid">
            <div className="mkt-hero__copy">
              <h1 className="mkt-h1">
                {HERO.beforeAccent}{" "}
                <span className="mkt-hero__accent">{HERO.accentWord}</span>{" "}
                {HERO.afterAccent}
              </h1>
              <WaitlistForm idPrefix="hero-waitlist" />
            </div>
            <HeroArt />
          </div>
        </div>
      </section>

      <section className="mkt-loop-section" aria-labelledby="mkt-loop-title">
        <div className="mkt-shell">
          <div className="mkt-loop-section__heading">
            <h2 id="mkt-loop-title">{LOOP_TITLE}</h2>
          </div>
        </div>
        <MarketplaceLoop />
      </section>

      <section id="features" className="mkt-section mkt-features">
        <div className="mkt-shell">
          <h2 className="mkt-h2 mkt-h2--display">{FEATURES_TITLE}</h2>
          <FeatureExplorer />
        </div>
      </section>

      <section id="why" className="mkt-section mkt-why">
        <div className="mkt-shell mkt-shell--narrow">
          <h2 className="mkt-h2">{WHY.title}</h2>
          <MarketingBento />
        </div>
      </section>

      <section id="faq" className="mkt-section mkt-faq">
        <div className="mkt-shell mkt-shell--prose">
          <h2 className="mkt-h2">{FAQ_TITLE}</h2>
          <div aria-hidden="true" className="mkt-faq__rule" />
          <Faq />
        </div>
      </section>
    </>
  );
}
