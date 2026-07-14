import { load } from "cheerio";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InboxClient } from "./inbox-client";

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
    expect(scrollRegion.find(".relative.mx-auto.h-72").next("h3").attr("class")).toContain("mt-10");
  });
});
