import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import HowItWorks, { metadata as tourMetadata } from "./(marketing)/tour/page";

vi.mock("@/components/marketing/reveal", () => ({
  Reveal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/marketing/demo-clip", () => ({
  DemoClip: () => <div />,
}));

vi.mock("@/components/marketing/faq-accordion", () => ({
  FaqAccordion: ({
    items,
  }: {
    items: ReadonlyArray<{ q: string; a: string }>;
  }) => (
    <div>
      {items.map((item) => (
        <section key={item.q}>
          <h3>{item.q}</h3>
          <p>{item.a}</p>
        </section>
      ))}
    </div>
  ),
}));

vi.mock("@/components/bits/ShinyText", () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

describe("pricing evidence copy", () => {
  it("qualifies sourced pricing in tour metadata", () => {
    expect(tourMetadata.description).toMatch(/cited web/i);
    expect(tourMetadata.description).toMatch(/depreciation/i);
    expect(tourMetadata.description).toMatch(/LLM-only.*may be uncited/i);
  });

  it("qualifies tour citations and the terminal LLM-only fallback", () => {
    const $ = load(renderToStaticMarkup(<HowItWorks />));
    const priceStep = $("#step-price").text();
    const pricingFaq = $("h3")
      .filter((_, heading) => $(heading).text() === "How accurate is the pricing?")
      .parent()
      .text();

    for (const copy of [priceStep, pricingFaq]) {
      expect(copy).toMatch(/ISBN.*sold[- ]comp.*web/i);
      expect(copy).toMatch(/LLM-only/i);
      expect(copy).toMatch(/lowest-confidence/i);
      expect(copy).toMatch(/may be uncited/i);
    }
  });
});
