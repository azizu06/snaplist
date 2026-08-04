/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logoLoopCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/components/bits/LogoLoop", () => ({
  default: (props: Record<string, unknown>) => {
    logoLoopCalls.push(props);
    return <div data-testid="logo-loop" />;
  },
}));

import { MarketplaceLoop } from "./marketplace-loop";

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

function renderLoop() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => root.render(<MarketplaceLoop />));

  return { container, root };
}

describe("MarketplaceLoop pause affordances", () => {
  let root: Root | undefined;

  beforeEach(() => {
    logoLoopCalls.length = 0;
    setReducedMotion(false);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  it("passes hover pause to LogoLoop and pauses while its keyboard group has focus", () => {
    const rendered = renderLoop();
    root = rendered.root;
    const motion = rendered.container.querySelector<HTMLElement>(".mkt-loop__motion");

    expect(motion).not.toBeNull();
    expect(motion?.tabIndex).toBe(0);
    expect(logoLoopCalls.at(-1)).toMatchObject({ pauseOnHover: true, pauseOnFocus: true, paused: false });

    act(() => motion?.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));

    expect(logoLoopCalls.at(-1)).toMatchObject({ paused: true });

    act(() => motion?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })));

    expect(logoLoopCalls.at(-1)).toMatchObject({ paused: false });
  });

  it("renders the static card fallback when reduced motion is requested", () => {
    setReducedMotion(true);
    const rendered = renderLoop();
    root = rendered.root;

    expect(rendered.container.querySelector(".mkt-loop--static")).not.toBeNull();
    expect(rendered.container.querySelector(".mkt-loop__motion")).toBeNull();
  });
});
