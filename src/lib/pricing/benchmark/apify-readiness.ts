import {
  classifySoldComp,
  type SoldCompClassification,
} from "../sold-comp-matcher";
import type { ItemSignal } from "../types";
import { normalizeApifySoldItems } from "../providers/apify-sold";

export type BalancedInventoryCondition =
  | "new"
  | "open-box"
  | "like-new"
  | "refurbished"
  | "used-good"
  | "used-fair"
  | "parts";

type ExpectedOutcome = SoldCompClassification | "normalization-reject";

interface LabeledActorFixtureRow {
  expected: ExpectedOutcome;
  raw: Record<string, unknown>;
}

export interface ApifyBalancedConditionFixture {
  condition: BalancedInventoryCondition;
  signal: ItemSignal;
  rows: readonly LabeledActorFixtureRow[];
}

const SOLD_AT = "2026-07-10T12:00:00.000Z";

function actorRow(
  key: string,
  title: string,
  condition: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    url: `https://www.ebay.com/itm/synthetic-${key}`,
    title,
    condition,
    soldPrice: 100,
    soldCurrency: "USD",
    endedAt: SOLD_AT,
    listingType: "buy_it_now",
    isBestOfferAccepted: false,
    ...overrides,
  };
}

function labeled(
  expected: ExpectedOutcome,
  raw: Record<string, unknown>,
): LabeledActorFixtureRow {
  return { expected, raw };
}

/**
 * Synthetic, privacy-safe contract corpus. Each condition has exactly five rows:
 * two valid price anchors, one condition/composition corroboration, one matcher
 * reject, and one normalization reject. It measures code behavior, not live
 * marketplace quality, and can never make a provider request.
 */
export const APIFY_BALANCED_CONDITION_FIXTURES: readonly ApifyBalancedConditionFixture[] = [
  {
    condition: "new",
    signal: { brand: "Fixture", model: "Orbit N100", condition: "new", conditionKnown: true },
    rows: [
      labeled("anchor", actorRow("new-a", "Fixture Orbit N100", "New")),
      labeled("anchor", actorRow("new-b", "Fixture Orbit N100", "Brand New")),
      labeled("corroboration", actorRow("new-c", "Fixture Orbit N100", "Used")),
      labeled("reject", actorRow("new-r", "Fixture Orbit N100 replacement case", "New")),
      labeled(
        "normalization-reject",
        actorRow("new-x", "Fixture Orbit N100", "New", { soldCurrency: "EUR" }),
      ),
    ],
  },
  {
    condition: "open-box",
    signal: {
      brand: "Fixture",
      model: "Orbit O200",
      condition: "open box",
      conditionKnown: true,
    },
    rows: [
      labeled("anchor", actorRow("open-a", "Fixture Orbit O200", "Open box")),
      labeled("anchor", actorRow("open-b", "Fixture Orbit O200", "Open package")),
      labeled("corroboration", actorRow("open-c", "Fixture Orbit O200", "Used")),
      labeled(
        "reject",
        actorRow("open-r", "Fixture Orbit O200", "Open box", {
          listingType: "best_offer_accepted",
          isBestOfferAccepted: true,
        }),
      ),
      labeled(
        "normalization-reject",
        actorRow("open-x", "Fixture Orbit O200", "Open box", { soldCurrency: "EUR" }),
      ),
    ],
  },
  {
    condition: "like-new",
    signal: {
      brand: "Fixture",
      model: "Orbit L300",
      condition: "like new",
      conditionKnown: true,
    },
    rows: [
      labeled("anchor", actorRow("like-a", "Fixture Orbit L300", "Like New")),
      labeled("anchor", actorRow("like-b", "Fixture Orbit L300", "Mint condition")),
      labeled("corroboration", actorRow("like-c", "Fixture Orbit L300", "New")),
      labeled("reject", actorRow("like-r", "Fixture Orbit L300 Max", "Like New")),
      labeled(
        "normalization-reject",
        actorRow("like-x", "Fixture Orbit L300", "Like New", { soldCurrency: "EUR" }),
      ),
    ],
  },
  {
    condition: "refurbished",
    signal: {
      brand: "Fixture",
      model: "Orbit R400",
      condition: "refurbished",
      conditionKnown: true,
    },
    rows: [
      labeled("anchor", actorRow("refurb-a", "Fixture Orbit R400", "Refurbished")),
      labeled(
        "anchor",
        actorRow("refurb-b", "Fixture Orbit R400", "Manufacturer Refurbished"),
      ),
      labeled("corroboration", actorRow("refurb-c", "Fixture Orbit R400", "Used")),
      labeled("reject", actorRow("refurb-r", "2 pack Fixture Orbit R400", "Refurbished")),
      labeled(
        "normalization-reject",
        actorRow("refurb-x", "Fixture Orbit R400", "Refurbished", { soldCurrency: "EUR" }),
      ),
    ],
  },
  {
    condition: "used-good",
    signal: {
      brand: "Fixture",
      model: "Orbit G500",
      condition: "good",
      conditionKnown: true,
    },
    rows: [
      labeled("anchor", actorRow("good-a", "Fixture Orbit G500", "Good")),
      labeled("anchor", actorRow("good-b", "Fixture Orbit G500", "Pre-Owned")),
      labeled("corroboration", actorRow("good-c", "Fixture Orbit G500", "New")),
      labeled("reject", actorRow("good-r", "Fixture Orbit G500 for parts", "For parts")),
      labeled(
        "normalization-reject",
        actorRow("good-x", "Fixture Orbit G500", "Good", { soldCurrency: "EUR" }),
      ),
    ],
  },
  {
    condition: "used-fair",
    signal: {
      brand: "Fixture",
      model: "Orbit F600",
      condition: "fair",
      conditionKnown: true,
    },
    rows: [
      labeled("anchor", actorRow("fair-a", "Fixture Orbit F600", "Fair")),
      labeled("anchor", actorRow("fair-b", "Fixture Orbit F600", "Acceptable")),
      labeled("corroboration", actorRow("fair-c", "Fixture Orbit F600", "Like New")),
      labeled("reject", actorRow("fair-r", "Fixture Orbit F600 replacement charger", "Fair")),
      labeled(
        "normalization-reject",
        actorRow("fair-x", "Fixture Orbit F600", "Fair", { soldCurrency: "EUR" }),
      ),
    ],
  },
  {
    condition: "parts",
    signal: {
      brand: "Fixture",
      model: "Orbit P700",
      condition: "for parts",
      conditionKnown: true,
    },
    rows: [
      labeled("anchor", actorRow("parts-a", "Fixture Orbit P700", "For parts")),
      labeled("anchor", actorRow("parts-b", "Fixture Orbit P700", "Not working")),
      labeled(
        "corroboration",
        actorRow("parts-c", "Fixture Orbit P700 bundle for parts", "For parts"),
      ),
      labeled("reject", actorRow("parts-r", "Fixture Orbit P700", "Used")),
      labeled(
        "normalization-reject",
        actorRow("parts-x", "Fixture Orbit P700", "For parts", { soldCurrency: "EUR" }),
      ),
    ],
  },
] as const;

export interface ApifyConditionEvaluation {
  condition: BalancedInventoryCondition;
  inputRows: number;
  normalizedRows: number;
  normalizationRejectRows: number;
  anchorRows: number;
  corroborationRows: number;
  rejectedRows: number;
  expectedValidComparableRows: number;
  validAnchorRows: number;
  anchorPrecision: number | null;
  validComparableRecall: number | null;
  classificationAccuracy: number | null;
  twoAnchorUsable: boolean;
}

export interface ApifyBalancedConditionSummary {
  schemaVersion: 1;
  providerRequests: 0;
  balanced: boolean;
  conditionCount: number;
  inputRows: number;
  normalizedRows: number;
  normalizationRejectRows: number;
  anchorRows: number;
  corroborationRows: number;
  rejectedRows: number;
  expectedValidComparableRows: number;
  validAnchorRows: number;
  anchorPrecision: number | null;
  validComparableRecall: number | null;
  twoAnchorCoverage: number | null;
  classificationAccuracy: number | null;
  conditions: ApifyConditionEvaluation[];
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

function evaluateCondition(
  fixture: ApifyBalancedConditionFixture,
): ApifyConditionEvaluation {
  const normalized = normalizeApifySoldItems(fixture.rows.map(({ raw }) => raw));
  const actualByUrl = new Map(
    normalized.map((comp) => [comp.url, classifySoldComp(comp, fixture.signal).classification]),
  );
  let correct = 0;
  let validAnchorRows = 0;
  for (const row of fixture.rows) {
    const url = String(row.raw.url);
    const actual = actualByUrl.get(url) ?? "normalization-reject";
    if (actual === row.expected) correct += 1;
    if (actual === "anchor" && row.expected === "anchor") validAnchorRows += 1;
  }
  const outcomes = [...actualByUrl.values()];
  const anchorRows = outcomes.filter((outcome) => outcome === "anchor").length;
  const corroborationRows = outcomes.filter((outcome) => outcome === "corroboration").length;
  const rejectedRows = outcomes.filter((outcome) => outcome === "reject").length;
  const expectedValidComparableRows = fixture.rows.filter(
    ({ expected }) => expected === "anchor",
  ).length;

  return {
    condition: fixture.condition,
    inputRows: fixture.rows.length,
    normalizedRows: normalized.length,
    normalizationRejectRows: fixture.rows.length - normalized.length,
    anchorRows,
    corroborationRows,
    rejectedRows,
    expectedValidComparableRows,
    validAnchorRows,
    anchorPrecision: ratio(validAnchorRows, anchorRows),
    validComparableRecall: ratio(validAnchorRows, expectedValidComparableRows),
    classificationAccuracy: ratio(correct, fixture.rows.length),
    twoAnchorUsable: anchorRows >= 2,
  };
}

export function evaluateApifyBalancedConditions(
  fixtures: readonly ApifyBalancedConditionFixture[] = APIFY_BALANCED_CONDITION_FIXTURES,
): ApifyBalancedConditionSummary {
  const conditions = fixtures.map(evaluateCondition);
  const sum = (field: keyof ApifyConditionEvaluation): number =>
    conditions.reduce((total, condition) => {
      const value = condition[field];
      return total + (typeof value === "number" ? value : 0);
    }, 0);
  const inputRows = sum("inputRows");
  const anchorRows = sum("anchorRows");
  const expectedValidComparableRows = sum("expectedValidComparableRows");
  const validAnchorRows = sum("validAnchorRows");
  const equalRowCounts = new Set(fixtures.map(({ rows }) => rows.length)).size <= 1;
  const distinctConditions = new Set(fixtures.map(({ condition }) => condition)).size;
  const correctRows = conditions.reduce(
    (total, condition) =>
      total + (condition.classificationAccuracy ?? 0) * condition.inputRows,
    0,
  );

  return {
    schemaVersion: 1,
    providerRequests: 0,
    balanced: equalRowCounts && distinctConditions === fixtures.length,
    conditionCount: fixtures.length,
    inputRows,
    normalizedRows: sum("normalizedRows"),
    normalizationRejectRows: sum("normalizationRejectRows"),
    anchorRows,
    corroborationRows: sum("corroborationRows"),
    rejectedRows: sum("rejectedRows"),
    expectedValidComparableRows,
    validAnchorRows,
    anchorPrecision: ratio(validAnchorRows, anchorRows),
    validComparableRecall: ratio(validAnchorRows, expectedValidComparableRows),
    twoAnchorCoverage: ratio(
      conditions.filter(({ twoAnchorUsable }) => twoAnchorUsable).length,
      conditions.length,
    ),
    classificationAccuracy: ratio(correctRows, inputRows),
    conditions,
  };
}

const percent = (value: number | null): string =>
  value == null ? "n/a" : `${(value * 100).toFixed(2)}%`;

function displayCondition(condition: BalancedInventoryCondition): string {
  return condition
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** Aggregate-only report: the summary cannot contain fixture rows or source identifiers. */
export function formatApifyBalancedConditionReport(
  summary: ApifyBalancedConditionSummary,
): string {
  const rows = summary.conditions.map(
    (condition) =>
      `| ${displayCondition(condition.condition)} | ${condition.inputRows} | ${condition.normalizedRows} | ${condition.anchorRows} | ${condition.corroborationRows} | ${condition.rejectedRows} | ${percent(condition.anchorPrecision)} | ${percent(condition.validComparableRecall)} | ${condition.twoAnchorUsable ? "yes" : "no"} |`,
  );
  return `# Apify sold-comp balanced-condition contract evaluation

- Provider requests: **0**
- Conditions: ${summary.conditionCount} (${summary.balanced ? "balanced" : "not balanced"})
- Synthetic input rows: ${summary.inputRows}; normalized: ${summary.normalizedRows}; normalization rejects: ${summary.normalizationRejectRows}
- Anchor precision: ${percent(summary.anchorPrecision)}
- Valid-comp recall into anchors: ${percent(summary.validComparableRecall)}
- Two-anchor coverage: ${percent(summary.twoAnchorCoverage)}
- Expected-outcome accuracy: ${percent(summary.classificationAccuracy)}

| Inventory condition | Input | Normalized | Anchors | Corroboration | Rejected | Anchor precision | Valid-comp recall | Two anchors |
|---|---:|---:|---:|---:|---:|---:|---:|:---:|
${rows.join("\n")}

This synthetic suite is a deterministic adapter/normalizer/matcher contract check, not a marketplace-quality estimate. Live retrieval precision, latency, and cost remain the measured Issue #188 evidence; the private listing-level rows are never copied into this output.
`;
}
