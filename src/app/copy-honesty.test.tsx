import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import HowItWorks, { metadata as tourMetadata } from "./(marketing)/tour/page";
import { SettingsView } from "./(app)/settings/settings-view";
import { sellerPolicyForTier } from "@/lib/billing/policy";

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

vi.mock("@/components/theme-toggle", () => ({
  ThemeSegmented: () => <div />,
}));

vi.mock("@/components/sign-out-button", () => ({
  AppSignOutButton: () => <button type="button">Sign out</button>,
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

describe("publish eligibility settings copy", () => {
  it("renders the shared core-capability matrix instead of a plan-only bulk claim", () => {
    const $ = load(
      renderToStaticMarkup(
        <SettingsView
          data={{
            user: { name: "Seller", email: "seller@example.com", imageUrl: null },
            autopilotEnabled: true,
            autoReplyEnabled: false,
            ebay: { connected: false, ebayUsername: null },
            billing: {
              tier: "free",
              itemsPerDay: 15,
              proItemsPerDay: 200,
              capabilities: sellerPolicyForTier("free").capabilities,
              billingEnabled: false,
            },
            error: null,
            ebayBanner: null,
          }}
          autopilotAction={async () => undefined}
          autoReplyAction={async () => undefined}
          disconnectEbayAction={async () => undefined}
        />,
      ),
    );

    const billingCard = $("h2")
      .filter((_, heading) => $(heading).text().includes("Plan & billing"))
      .closest("section")
      .text();
    expect(billingCard).toMatch(/core seller workflows/i);
    expect(billingCard).toMatch(/bulk \/ haul capture/i);
  });

  it("discloses the automatic repricing dependency", () => {
    const $ = load(
      renderToStaticMarkup(
        <SettingsView
          data={{
            user: { name: "Seller", email: "seller@example.com", imageUrl: null },
            autopilotEnabled: true,
            autoReplyEnabled: false,
            ebay: { connected: false, ebayUsername: null },
            billing: {
              tier: "free",
              itemsPerDay: 15,
              proItemsPerDay: 200,
              capabilities: sellerPolicyForTier("free").capabilities,
              billingEnabled: false,
            },
            error: null,
            ebayBanner: null,
          }}
          autopilotAction={async () => undefined}
          autoReplyAction={async () => undefined}
          disconnectEbayAction={async () => undefined}
        />,
      ),
    );
    const publishEligibilityCard = $("h2")
      .filter((_, heading) => $(heading).text().includes("Publish eligibility"))
      .closest("section")
      .text();

    expect(publishEligibilityCard).toMatch(/turning it off.*automatic repricing/i);
    expect(publishEligibilityCard).toMatch(/existing live listings/i);
    expect(publishEligibilityCard).toMatch(/auto-reprice.*enabled/i);
  });

  it("presents one narrow default-off safe-answer preference", () => {
    const $ = load(
      renderToStaticMarkup(
        <SettingsView
          data={{
            user: { name: "Seller", email: "seller@example.com", imageUrl: null },
            autopilotEnabled: true,
            autoReplyEnabled: false,
            ebay: { connected: true, ebayUsername: "seller" },
            billing: {
              tier: "free",
              itemsPerDay: 15,
              proItemsPerDay: 200,
              capabilities: sellerPolicyForTier("free").capabilities,
              billingEnabled: false,
            },
            error: null,
            ebayBanner: null,
          }}
          autopilotAction={async () => undefined}
          autoReplyAction={async () => undefined}
          disconnectEbayAction={async () => undefined}
        />,
      ),
    );
    const card = $("h2")
      .filter((_, heading) => $(heading).text().includes("Safe buyer auto-replies"))
      .closest("section");
    expect(card.text()).toMatch(/automatically answer safe factual questions/i);
    expect(card.text()).toMatch(/off by default/i);
    expect(card.text()).toMatch(/offers.*shipping.*returns/i);
    expect(card.find('[role="switch"]').attr("aria-checked")).toBe("false");
    expect(card.text()).not.toMatch(/category rules|custom prompt|personality/i);
  });
});
