import type { Metadata } from "next";
import Image from "next/image";
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
  TROPHY_WALL,
  TROPHY_WALL_ROWS,
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
              <h1 className="mkt-h1">{HERO.title}</h1>
              <WaitlistForm idPrefix="hero-waitlist" />
            </div>
            <HeroArt />
          </div>
        </div>
      </section>

      <section id="features" className="mkt-section mkt-features">
        <div className="mkt-shell">
          <h2 className="mkt-h2 mkt-h2--display">{FEATURES_TITLE}</h2>
          <FeatureExplorer />
        </div>
      </section>

      <section className="mkt-loop-section" aria-labelledby="mkt-loop-title">
        <div className="mkt-shell">
          <div className="mkt-loop-section__heading">
            <h2 id="mkt-loop-title">From camera roll to every storefront.</h2>
          </div>
        </div>
        <MarketplaceLoop />
      </section>

      <section id="trophy" className="mkt-section mkt-trophy">
        <div className="mkt-shell mkt-shell--narrow">
          <div className="mkt-trophy__grid">
            <div className="mkt-trophy__copy">
              <h2 className="mkt-trophy__h2">{TROPHY_WALL.title}</h2>
            </div>
            <div className="mkt-trophy__art">
              {/* Scout sits above the frame, never inside it: he is a companion
                  in the native app, not an element of the Trophy Wall screen. */}
              <Image
                className="mkt-trophy__scout"
                src="/brand/scout-reviewing.png"
                alt=""
                aria-hidden="true"
                width={239}
                height={203}
              />
              <div className="mkt-trophy__device" aria-hidden="true">
                <span className="mkt-phone__notch" />
                <span className="mkt-phone__chip">Illustrative</span>
                <div className="mkt-phone__screen">
                  <div className="mkt-scr__bar">
                    <span className="mkt-scr__title">Trophy Wall</span>
                  </div>
                  <div className="mkt-scr__body">
                    {TROPHY_WALL_ROWS.map((row) => (
                      <div key={row.id} className="mkt-trophy__row">
                        <div className="mkt-trophy__row-art" />
                        <span className="mkt-trophy__row-title">{row.title}</span>
                        <span className="mkt-trophy__state">{row.state}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
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
