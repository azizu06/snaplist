import { load } from "cheerio";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InboxClient } from "./inbox-client";
import { INBOX_EMPTY_DEMO } from "./inbox-demo-video";
import { InboxEmptyState } from "./inbox-empty";

vi.mock("@/lib/supabase/client", () => ({
  useSupabaseClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => undefined,
  }),
}));

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get: (_target, element: string) =>
        ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(element, props, children),
    },
  ),
  useReducedMotion: () => false,
}));

describe("inbox zero-question layout", () => {
  it("uses an internal flex scroll region so the fixed app shell never clips the empty state", () => {
    const $ = load(
      renderToStaticMarkup(
        <InboxClient
          userId="seller"
          initialMessages={[]}
          initialAttachments={[]}
          items={[{ id: "item-1", label: "Camera kit" }]}
        />,
      ),
    );
    const scrollRegion = $("[data-inbox-empty-scroll-region]");

    expect(scrollRegion).toHaveLength(1);
    expect(scrollRegion.attr("class")).toContain("min-h-0");
    expect(scrollRegion.attr("class")).toContain("flex-1");
    expect(scrollRegion.attr("class")).toContain("overflow-y-auto");
    expect(scrollRegion.attr("class")).toContain("overflow-x-hidden");
    expect(scrollRegion.find("[data-inbox-empty-content]")).toHaveLength(1);
  });

  it("gives the faded preview breathing room and keeps the walkthrough readable", () => {
    const $ = load(renderToStaticMarkup(<InboxEmptyState />));
    const state = $("[data-inbox-empty-state]");

    expect(state.find("[data-inbox-sample-thread]").attr("class")).toContain("h-80");
    expect(state.find("h3").attr("class")).toContain("mt-12");
    expect(state.text()).toContain("No reply has been sent.");
    expect(state.text()).not.toMatch(/[—–]/);

    const demo = state.find("[data-inbox-demo]");
    expect(demo).toHaveLength(1);
    expect(demo.find("[data-inbox-demo-frame]").attr("class")).toContain("max-w-[560px]");
    expect(INBOX_EMPTY_DEMO).toEqual({
      src: "/demo/inbox-qa-mobile.mp4",
      formFactor: "mobile",
    });
  });
});
