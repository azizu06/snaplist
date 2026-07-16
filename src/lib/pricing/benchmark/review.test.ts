import { describe, expect, it } from "vitest";
import { parseHumanLabelFile, parseProductResearchFile } from "./review";

describe("manual review inputs", () => {
  it("does not accept heuristic labels until a human explicitly confirms them", () => {
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
    ).toThrow(/reviewedByHuman=true/);
  });

  it("retains only redacted Product Research aggregates after complete manual review", () => {
    const result = parseProductResearchFile(
      {
        reviewedByHuman: true,
        rows: [
          {
            queryId: "Q01",
            resultCount: 12,
            median: 9.5,
            range: { min: 4, max: 16 },
            reviewedAt: "2026-07-16",
            sellerUsername: "must-be-ignored",
          },
        ],
      },
      ["Q01"],
    );

    expect(result.status).toBe("complete");
    expect(result.rows).toEqual([
      {
        queryId: "Q01",
        resultCount: 12,
        median: 9.5,
        range: { min: 4, max: 16 },
        reviewedAt: "2026-07-16",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("must-be-ignored");
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
    ).toThrow(/Duplicate human label/);

    expect(() =>
      parseProductResearchFile(
        {
          reviewedByHuman: true,
          rows: [
            {
              queryId: "Q01",
              resultCount: 12,
              median: 20,
              range: { min: 4, max: 16 },
            },
          ],
        },
        ["Q01"],
      ),
    ).toThrow(/Invalid Product Research aggregate/);
  });
});
