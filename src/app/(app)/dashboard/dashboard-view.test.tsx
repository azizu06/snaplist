import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DashboardView, type DashboardRow } from "./dashboard-view";

vi.mock("next/link", () => ({
  default: ({ href, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props} />
  ),
}));

const row = (status: string): DashboardRow => ({
  itemId: `${status}-item`,
  listingId: `${status}-listing`,
  title: `${status} item`,
  status,
  createdAt: "2026-07-13T00:00:00.000Z",
  price: 40,
  costBasis: null,
  thumbUrl: null,
  category: "Electronics",
  condition: "Good",
});

function renderRow(status: string) {
  return load(
    renderToStaticMarkup(
      <DashboardView
        rows={[row(status)]}
        counts={{ draft: 0, attention: 0, live: 0 }}
        filter="all"
      />,
    ),
  );
}

describe("dashboard row navigation", () => {
  it("keeps non-interactive status cells below the stretched review link", () => {
    const $ = renderRow("draft");
    const statusCell = $('span[class*="md:flex-col"]');
    const reviewLink = $('a[aria-label="Open draft item"]');

    expect(statusCell).toHaveLength(1);
    expect(statusCell.attr("class")).not.toContain("z-[2]");
    expect(reviewLink).toHaveLength(1);
    expect(reviewLink.attr("class")).toContain("absolute inset-0 z-[1]");
  });

  it("raises only manual publish controls above the stretched review link", () => {
    const $ = renderRow("queued");
    const publishLinks = $('a[aria-label="Publish queued item to eBay"]');

    expect(publishLinks).toHaveLength(2);
    publishLinks.each((_, link) => {
      expect($(link).attr("class")).toContain("relative z-[2]");
    });
  });
});
