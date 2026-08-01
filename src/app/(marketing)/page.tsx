import type { Metadata } from "next";
import Image from "next/image";
import { AppStoreButton } from "@/components/marketing/app-store-button";
import { Faq } from "@/components/marketing/faq";
import { FeatureExplorer } from "@/components/marketing/feature-explorer";
import { HeroArt } from "@/components/marketing/hero-art";
import { ValueCards } from "@/components/marketing/value-cards";
import {
  CTA,
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
 * The page is a single scroll with no internal routes: Features and FAQ are
 * in-page anchors, and the only outbound destinations are the App Store, the
 * privacy policy, and support. That is deliberate — the product is an iOS app,
 * and a marketing page with signed-in destinations would advertise a web app
 * that no longer exists.
 *
 * All copy lives in `src/lib/marketing/site.ts` so the honesty test can derive
 * its assertions from product capability rather than from pinned sentences.
 */
export const metadata: Metadata = {
  title: "SnapList — turn photos into a listing you approve",
  description: HERO.body,
};

export default function LandingPage() {
  return (
    <>
      <section className="mkt-hero">
        <div className="mkt-shell">
          <div className="mkt-hero__grid">
            <div className="mkt-hero__copy">
              <h1 className="mkt-h1">{HERO.title}</h1>
              <p className="mkt-lede">{HERO.lede}</p>
              <p className="mkt-sub">{HERO.body}</p>
              <AppStoreButton />
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

      <section id="why" className="mkt-section mkt-why">
        <div className="mkt-shell mkt-shell--narrow">
          <h2 className="mkt-h2">{WHY.title}</h2>
          <p className="mkt-why__lede">{WHY.body}</p>
          <ValueCards />
        </div>
      </section>

      <section id="trophy" className="mkt-section mkt-trophy">
        <div className="mkt-shell mkt-shell--narrow">
          <div className="mkt-trophy__grid">
            <div className="mkt-trophy__copy">
              <h2 className="mkt-trophy__h2">{TROPHY_WALL.title}</h2>
              <p className="mkt-trophy__accent">{TROPHY_WALL.accent}</p>
              <p className="mkt-trophy__body">{TROPHY_WALL.body}</p>
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

      <section id="faq" className="mkt-section mkt-faq">
        <div className="mkt-shell mkt-shell--prose">
          <h2 className="mkt-h2">{FAQ_TITLE}</h2>
          <div aria-hidden="true" className="mkt-faq__rule" />
          <Faq />
        </div>
      </section>

      <section className="mkt-section mkt-cta">
        <div className="mkt-shell mkt-shell--prose">
          <h2 className="mkt-cta__h2">{CTA.title}</h2>
          <p className="mkt-cta__body">{CTA.body}</p>
          <div className="mkt-cta__row">
            <AppStoreButton size="lg" />
          </div>
        </div>
      </section>
    </>
  );
}
