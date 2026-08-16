"use client";

import Image from "next/image";
import { useCallback, useState } from "react";

/**
 * The hero camera, looping.
 *
 * The hero used to be one still capture of the camera. It now cycles through
 * five items so the page shows what the product is for rather than what one
 * screen looks like.
 *
 * How it is built matters more than how it looks. The camera chrome is not
 * redrawn: it is the shipping Scan screen with the viewfinder photo knocked out
 * to transparency, so the flash button, framing corners, shutter, library
 * button and tab bar are the same pixels as the App Store capture. Only the
 * subject behind them changes. That keeps the hero inside Apple guideline
 * 2.3.3, which forbids showing interface the app does not have, without
 * anyone having to keep a drawing in sync with the build.
 *
 * The shutter is a second layer cut from the same capture so it can pulse
 * without any of it being redrawn.
 *
 * The sweep line is the one element here that is not app interface. It is a
 * marketing device and it stays on this page. It must not be carried into an
 * App Store panel, where it would read as a capture claim.
 */

type LoopItem = { src: string; label: string };

/**
 * Every item is a recognisable branded thing someone would actually resell.
 * Two constraints picked these particular photographs. The subject has to
 * survive a 0.46 crop, which rules out wide landscape compositions, and the top
 * of the frame has to stay dark, because the status bar is white text sitting
 * directly on the photo and the approved v4 Scan package allows no scrim behind
 * it.
 */
const ITEMS: LoopItem[] = [
  { src: "/marketing/hero/fender.webp", label: "a Fender Stratocaster beside a Marshall amp" },
  { src: "/marketing/hero/nikedunk.webp", label: "a pair of Nike Dunks" },
  { src: "/marketing/hero/rolex.webp", label: "a Rolex Submariner" },
  { src: "/marketing/hero/sony.webp", label: "a Sony Alpha camera" },
  { src: "/marketing/hero/nintendo.webp", label: "a boxed Nintendo Switch" },
];

const SHOT_WIDTH = 744;
const SHOT_HEIGHT = 1610;

export function HeroScanLoop() {
  const [index, setIndex] = useState(0);

  /**
   * The beats are CSS animations that all share one duration, so they stay in
   * phase with each other on their own. Advancing the item on the flash's
   * iteration boundary ties the swap to that same clock, instead of a second
   * timer that would drift away from the beat the viewer just watched.
   *
   * It also gives reduced motion for free. The CSS stops the animation, no
   * iteration is ever delivered, and nothing else here can move off the first
   * item.
   */
  const advance = useCallback(() => {
    setIndex((current) => (current + 1) % ITEMS.length);
  }, []);

  return (
    <div
      className="mkt-scanloop"
      role="img"
      aria-label="The SnapList camera scanning one item after another: a Fender Stratocaster, a pair of Nike Dunks, a Rolex Submariner, a Sony camera and a boxed Nintendo Switch."
    >
      {ITEMS.map((item, itemIndex) => (
        <Image
          key={item.src}
          className="mkt-scanloop__item"
          data-active={itemIndex === index}
          src={item.src}
          alt=""
          width={SHOT_WIDTH}
          height={SHOT_HEIGHT}
          sizes="(max-width: 879px) 82vw, 340px"
          priority={itemIndex === 0}
        />
      ))}

      <div className="mkt-scanloop__sweep" aria-hidden="true" />
      <div className="mkt-scanloop__flash" aria-hidden="true" onAnimationIteration={advance} />

      <Image
        className="mkt-scanloop__chrome"
        src="/marketing/hero/chrome.webp"
        alt=""
        width={SHOT_WIDTH}
        height={SHOT_HEIGHT}
        priority
      />
      <Image
        className="mkt-scanloop__shutter"
        src="/marketing/hero/shutter.webp"
        alt=""
        width={165}
        height={174}
        priority
      />
    </div>
  );
}
