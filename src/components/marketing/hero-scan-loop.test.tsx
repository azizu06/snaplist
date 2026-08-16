// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { HeroScanLoop } from "@/components/marketing/hero-scan-loop";

/**
 * The loop advances on the flash animation's iteration boundary rather than on
 * a timer of its own, so the item swap cannot drift away from the beat the
 * viewer just watched. That is the whole reason it is wired this way, and it is
 * invisible in the markup, so it is asserted here.
 *
 * This also pins the reduced-motion contract from the other side. CSS turns the
 * animation off, no iteration is ever delivered, and the component holds on its
 * first item. Nothing else in the component moves it.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<HeroScanLoop />));
  return host;
}

function activeIndex(container: HTMLElement) {
  const items = [...container.querySelectorAll(".mkt-scanloop__item")];
  return items.findIndex((item) => item.getAttribute("data-active") === "true");
}

function beat(container: HTMLElement) {
  const flash = container.querySelector(".mkt-scanloop__flash");
  if (!flash) throw new Error("no flash element to drive the loop");
  act(() => {
    flash.dispatchEvent(new Event("animationiteration", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("hero scanning loop", () => {
  it("advances one item per animation cycle and wraps", () => {
    const container = render();
    const count = container.querySelectorAll(".mkt-scanloop__item").length;

    expect(count).toBe(5);
    expect(activeIndex(container)).toBe(0);

    beat(container);
    expect(activeIndex(container)).toBe(1);

    beat(container);
    expect(activeIndex(container)).toBe(2);

    for (let i = 0; i < count - 2; i += 1) beat(container);
    expect(activeIndex(container)).toBe(0);
  });

  it("shows exactly one item at a time", () => {
    const container = render();

    for (let i = 0; i < 7; i += 1) {
      expect(container.querySelectorAll('.mkt-scanloop__item[data-active="true"]').length).toBe(1);
      beat(container);
    }
  });

  it("holds on the first item when no cycle is ever delivered", () => {
    const container = render();

    // What reduced motion looks like from the component's side: the CSS
    // animation never runs, so nothing here can move off the first item.
    expect(activeIndex(container)).toBe(0);
    expect(container.querySelector(".mkt-scanloop")?.getAttribute("aria-label")).toBeTruthy();
  });
});
