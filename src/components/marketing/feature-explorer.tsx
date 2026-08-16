"use client";

import { useCallback, useRef, useState } from "react";
import { FEATURE_STEPS } from "@/lib/marketing/site";
import {
  ListingReviewScreen,
  PhotoReviewScreen,
  PublishScreen,
  ScanScreen,
  TrophyWallScreen,
} from "@/components/marketing/phone-screens";

const SCREENS = [ScanScreen, PhotoReviewScreen, ListingReviewScreen, PublishScreen, TrophyWallScreen] as const;

/** Vertical list, but Left/Right are accepted too because the dots read horizontal. */
const STEP: Record<string, number> = {
  ArrowUp: -1,
  ArrowLeft: -1,
  ArrowDown: 1,
  ArrowRight: 1,
};

/**
 * The signature section: five selector cards drive one feature phone.
 *
 * Semantics are a WAI-ARIA tablist with a single tabpanel. Two consequences are
 * deliberate:
 *
 * - Roving tabindex. Only the selected card is tabbable, so Tab moves past the
 *   whole group in one press and Arrow/Home/End move within it. Five separately
 *   tabbable cards would make the section a keyboard obstacle.
 * - Exactly one screen is exposed. The inactive slides stay mounted so the swap
 *   can cross-fade, but they are `visibility: hidden`, which takes them out of
 *   the accessibility tree — otherwise a screen reader would read five screens'
 *   worth of text for one visible phone.
 *
 * Activation follows focus (arrowing selects), which is the APG default for tabs
 * whose panels are cheap to render. Nothing here fetches.
 */
export function FeatureExplorer() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onTabKey = useCallback((event: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (event.key in STEP) {
      next = (index + STEP[event.key] + FEATURE_STEPS.length) % FEATURE_STEPS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = FEATURE_STEPS.length - 1;
    }
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    // Focus has to follow the roving tabindex, or the next Arrow press starts
    // from a card that is no longer tabbable and the group traps.
    tabs.current[next]?.focus();
  }, []);

  return (
    <div className="mkt-explorer">
      <div className="mkt-explorer__stage">
        <div
          id="mkt-feature-panel"
          role="tabpanel"
          aria-labelledby={`mkt-feature-tab-${FEATURE_STEPS[active].id}`}
          className="mkt-explorer__panel"
        >
          <div className="mkt-explorer__frame">
            <div className="mkt-explorer__scale">
              <div className="mkt-explorer__device">
                {/* The device draws its own volume and power buttons as
                    pseudo-elements; this is the third, the action button. */}
                <span className="mkt-phone__action" aria-hidden="true" />
                <div className="mkt-phone__screen">
                  {SCREENS.map((Screen, index) => (
                    <div
                      key={FEATURE_STEPS[index].id}
                      className="mkt-explorer__slide"
                      data-active={index === active}
                    >
                      <Screen />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mkt-dots">
          {FEATURE_STEPS.map((step, index) => (
            <button
              key={step.id}
              type="button"
              className="mkt-dots__btn"
              aria-label={`Show ${step.title} screen`}
              aria-current={index === active}
              onClick={() => setActive(index)}
            >
              <span aria-hidden="true" className="mkt-dots__dot" />
            </button>
          ))}
        </div>
      </div>

      <div role="tablist" aria-label="SnapList steps" aria-orientation="vertical" className="mkt-tablist">
        {FEATURE_STEPS.map((step, index) => (
          <button
            key={step.id}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`mkt-feature-tab-${step.id}`}
            className="mkt-tab"
            aria-selected={index === active}
            aria-controls="mkt-feature-panel"
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            <span className="mkt-tab__title">{step.title}</span>
            <span className="mkt-tab__body">{step.body}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
