"use client";

import { useLayoutEffect } from "react";

const FOCUS_SELECTORS: Record<string, string> = {
  price: "#review-price",
  write: "#review-title",
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
 *   ?focus=price      center the real review price card
 *   ?focus=write      center the real listing editor
 *   ?capture=list     show the mobile inbox conversation list
 *   ?capture=sent     show a completed Patagonia buyer thread
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

    let nestedTimer: number | undefined;
    const timer = window.setTimeout(() => {
      if (focus && FOCUS_SELECTORS[focus]) {
        document
          .querySelector(FOCUS_SELECTORS[focus])
          ?.scrollIntoView({ block: "center", inline: "nearest" });
      }

      if (capture === "list") {
        clickButton("Back to conversations");
      }

      if (capture === "sent") {
        clickButton("Back to conversations");
        nestedTimer = window.setTimeout(
          () => clickButton("Patagonia Better Sweater"),
          120,
        );
      }

      document.documentElement.dataset.demoCaptureReady = "true";
    }, 500);

    return () => {
      window.clearTimeout(timer);
      if (nestedTimer !== undefined) window.clearTimeout(nestedTimer);
      delete document.documentElement.dataset.demoCaptureReady;
      delete document.documentElement.dataset.demoCaptureActive;
    };
  }, []);

  return null;
}
