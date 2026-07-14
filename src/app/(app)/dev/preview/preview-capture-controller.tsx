"use client";

import { useLayoutEffect } from "react";

const FOCUS_SELECTORS: Record<string, string> = {
  upload: "#upload-photos",
  identify: "#review-identification",
  price: "#review-price-card",
  write: "#review-title",
  publish: "#publish-action",
};

function clickButton(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label")?.includes(label) ||
      candidate.textContent?.includes(label),
  );
  button?.click();
}

/**
 * Query controls consumed only by remotion/scripts/capture-real-ui.mjs:
 *   ?theme=dark       align the real app theme before capture
 *   ?focus=...        center the real action/card named above
 *   ?capture=list     show the mobile inbox conversation list
 *   ?capture=filled   add the PlayStation 5 photo through the real file input
 *   ?capture=sent     show a completed Sony camera buyer thread
 */
export function PreviewCaptureController() {
  useLayoutEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const theme = params.get("theme");
    const focus = params.get("focus");
    const capture = params.get("capture");

    if (theme === "dark" || theme === "light") {
      document.documentElement.dataset.demoCaptureActive = "true";
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.classList.toggle("light", theme === "light");
      document.documentElement.style.colorScheme = theme;
      window.localStorage.setItem("theme", theme);
    }

    const timers = new Set<number>();
    let cancelled = false;
    const later = (callback: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        callback();
      }, ms);
      timers.add(id);
    };
    const markReady = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) document.documentElement.dataset.demoCaptureReady = "true";
        });
      });
    };

    const prepare = () => {
      if (
        capture === "filled" &&
        document.documentElement.dataset.demoInteractionReady !== "true"
      ) {
        later(prepare, 50);
        return;
      }

      if (focus && FOCUS_SELECTORS[focus]) {
        document
          .querySelector(FOCUS_SELECTORS[focus])
          ?.scrollIntoView({ block: "center", inline: "nearest" });
      }

      if (capture === "list") {
        clickButton("Back to conversations");
        later(markReady, 320);
        return;
      }

      if (capture === "sent") {
        clickButton("Back to conversations");
        later(() => clickButton("Sony mirrorless camera kit"), 120);
        later(markReady, 480);
        return;
      }

      markReady();
    };
    later(prepare, 500);

    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
      delete document.documentElement.dataset.demoCaptureReady;
      delete document.documentElement.dataset.demoCaptureActive;
    };
  }, []);

  return null;
}
