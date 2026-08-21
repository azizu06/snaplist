"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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

/** Below this the explorer stacks the phone over the cards and Scout has nowhere to stand. */
const SCOUT_MIN_WIDTH = "(min-width: 760px)";

/**
 * Reads a media query as state, through the store API rather than an effect.
 *
 * The server snapshot is `false` on purpose. It means the markup React sends
 * never contains Scout, whatever the eventual viewport is, so hydration has
 * nothing to reconcile; the client subscribes, reads the real value, and adds
 * him on the next render.
 */
function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Scout mounts only when the phone is near the viewport and wide enough to hold him.
 *
 * Both halves are about bytes. The five clips total about 4 MB, and while only
 * one is ever fetched at a time, a `<video>` sitting in the initial tree starts
 * downloading whether or not anyone scrolls this far. Gating on intersection
 * means a visitor who reads the hero and leaves pays nothing, and gating on
 * width means a phone pays nothing at all, since Scout is hidden there anyway.
 *
 * A CSS `display: none` would do neither: the element still mounts and the
 * browser still fetches the clip. That is why the breakpoint is duplicated here
 * as a media query rather than left to the stylesheet.
 *
 * There is no fallback for a missing IntersectionObserver. Every engine that can
 * decode VP9 alpha has had one for years, and the honest failure for a browser
 * that somehow lacks it is a missing decoration, not a mount that skips the gate.
 */
function useScoutMount(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  const wide = useMediaQuery(SCOUT_MIN_WIDTH);

  useEffect(() => {
    const node = ref.current;
    if (!node || near || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [ref, near]);

  return near && wide;
}

/**
 * Scout stands on the phone and reacts to the selected step.
 *
 * The clips are the accepted Higgsfield motion set, VP9 with a real alpha
 * channel, so the character composites straight onto the section background with
 * no plate behind it. Remounting on `id` is deliberate: swapping `src` on a live
 * element keeps the old frame on screen until the new one decodes, and `key`
 * gives a clean element that starts at frame zero.
 *
 * Reduced Motion still gets Scout, held on his first frame. Hiding him would
 * remove content rather than remove motion, and a `<video>` ignores the CSS
 * media query, so the pause has to happen here.
 *
 * Which source clip fills each slot, and why the liveliest ones do not:
 *
 *   scan            048 welcome-wave
 *   photo-review    034 coaching-photo
 *   listing-review  007 magnifier-inspection
 *   publish         046 listing-ready
 *   trophy-wall     042 reassurance
 *
 * Three clips in the set are held out on product truth rather than looks, and
 * they happen to be three of the four most animated: 030 (tape gun and
 * cardboard box) implies fulfillment, 032 (barcode scanner) implies a capture
 * mode that does not exist, and 029 (tape measure) implies measurement. All
 * three are named out of scope in the PRD, and a mascot beside a claim is read
 * as part of the claim. 041 is unusable for a second reason: its frame is
 * 1112px rather than 960 and the figure's feet sit at 67% of it, so it would
 * float rather than stand.
 *
 * Slot geometry depends on where the figure sits inside its square frame. The
 * five above put the top of the head between 8.3% and 12.9% down, and the feet
 * between 86.9% and 90.5%, which is why the CSS can pin one box and have every
 * pose land on the phone. Measure a replacement's alpha bounds before swapping
 * it in.
 */
function ExplorerScout({ id }: { id: string }) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    node.pause();
    const hold = () => node.pause();
    node.addEventListener("loadeddata", hold);
    return () => node.removeEventListener("loadeddata", hold);
  }, [id]);

  return (
    <video
      key={id}
      ref={video}
      className="mkt-explorer__scout"
      src={`/scout/${id}.webm`}
      aria-hidden="true"
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      tabIndex={-1}
    />
  );
}

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
  const stage = useRef<HTMLDivElement>(null);
  const scoutReady = useScoutMount(stage);

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
      <div className="mkt-explorer__stage" ref={stage}>
        <div
          id="mkt-feature-panel"
          role="tabpanel"
          aria-labelledby={`mkt-feature-tab-${FEATURE_STEPS[active].id}`}
          className="mkt-explorer__panel"
        >
          <div className="mkt-explorer__frame">
            {scoutReady ? <ExplorerScout id={FEATURE_STEPS[active].id} /> : null}
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
