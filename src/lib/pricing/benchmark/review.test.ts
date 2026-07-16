import { describe, expect, it } from "vitest";
import { parseHumanLabelFile, parseProductResearchFile } from "./review";

describe("manual review inputs", () => {
  it("does not accept heuristic labels until a supported reviewer is attributed", () => {
    expect(() =>
      parseHumanLabelFile({
        reviewedByHuman: false,
        labels: [
          {
            compId: "abc",
            relevant: true,
            variantCorrect: true,
            conditionCorrect: true,
          },
        ],
      }),
    ).toThrow(/Attributed labels/);
  });

  it("accepts a complete Codex agent-assisted label review without calling it human review", () => {
    const parsed = parseHumanLabelFile({
      reviewedByAgent: true,
      reviewMethod: "codex-agent-assisted",
      labels: [
        {
          compId: "abc",
          relevant: true,
          variantCorrect: true,
          conditionCorrect: false,
        },
      ],
    });

    expect(parsed.reviewMethod).toBe("codex-agent-assisted");
    expect(parsed.labels).toEqual([
      {
        compId: "abc",
        relevant: true,
        variantCorrect: true,
        conditionCorrect: false,
      },
    ]);
  });

  it("retains only redacted Product Research summaries from an operator-authorized Codex capture", () => {
    const result = parseProductResearchFile(
      {
        source: "eBay Seller Hub Product Research",
        capturedAt: "2026-07-16",
        reviewMethod: "authenticated in-app browser, operator-authorized Codex assistance",
        window: "Last 90 days",
        tab: "Sold",
        queries: [
          {
            id: "Q01",
            condition: "Used",
            averageSoldPriceUsd: 9.5,
            soldPriceMinUsd: 4,
            soldPriceMaxUsd: 16,
            sellThroughPct: 42.5,
            totalSellers: 12,
            sellerUsername: "must-be-ignored",
          },
        ],
      },
      ["Q01"],
    );

    expect(result.status).toBe("complete");
    expect(result.reviewMethod).toBe("codex-assisted-operator");
    expect(result.rows).toEqual([
      {
        queryId: "Q01",
        condition: "Used",
        average: 9.5,
        range: { min: 4, max: 16 },
        sellThroughPct: 42.5,
        totalSellers: 12,
        capturedAt: "2026-07-16",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("must-be-ignored");
    expect(JSON.stringify(result)).not.toContain("median");
  });

  it("rejects duplicate labels and impossible Product Research aggregates", () => {
    const label = {
      compId: "abc",
      relevant: true,
      variantCorrect: true,
      conditionCorrect: true,
    };
    expect(() =>
      parseHumanLabelFile({
        reviewedByHuman: true,
        labels: [label, label],
      }),
    ).toThrow(/Duplicate attributed label/);

    expect(() =>
      parseProductResearchFile(
        {
          reviewMethod: "authenticated in-app browser, operator-authorized Codex assistance",
          capturedAt: "2026-07-16",
          window: "Last 90 days",
          tab: "Sold",
          queries: [
            {
              id: "Q01",
              condition: "Used",
              averageSoldPriceUsd: 20,
              soldPriceMinUsd: 4,
              soldPriceMaxUsd: 16,
              sellThroughPct: 120,
              totalSellers: 12,
            },
          ],
        },
        ["Q01"],
      ),
    ).toThrow(/Invalid Product Research aggregate/);
  });
});
