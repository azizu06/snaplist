import { SOLD_COMPS_BENCHMARK_CORPUS } from "./corpus";
import type {
  BenchmarkCapture,
  BenchmarkComp,
  BenchmarkCompLabel,
  BenchmarkCorpusEntry,
  ProductResearchStatus,
} from "./types";

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  return normalized(text).includes(normalized(phrase));
}

function suggestedConditionCorrect(
  entry: BenchmarkCorpusEntry,
  comp: BenchmarkComp,
): boolean {
  if (entry.humanRule.targetCondition === "any") return true;
  const condition = normalized(comp.condition ?? "");
  if (!condition) return false;
  const looksNew = /\b(new|sealed|unopened|brand new)\b/.test(condition) &&
    !/\blike new\b/.test(condition);
  return entry.humanRule.targetCondition === "new" ? looksNew : !looksNew;
}

export interface PrivateReviewRow {
  queryId: string;
  provider: string;
  compId: string;
  title: string;
  condition: string | null;
  displayedPrice: number;
  priceDisclosure: BenchmarkComp["priceDisclosure"];
  suggested: BenchmarkCompLabel;
}

export function buildPrivateReviewRows(capture: BenchmarkCapture): PrivateReviewRow[] {
  const corpus = new Map(SOLD_COMPS_BENCHMARK_CORPUS.map((entry) => [entry.id, entry]));
  return capture.queries.flatMap((query) => {
    const entry = corpus.get(query.queryId);
    if (!entry) return [];
    return query.comps.map((comp) => {
      const required = entry.humanRule.requiredPhraseGroups.every((group) =>
        group.some((phrase) => containsPhrase(comp.title, phrase)),
      );
      const forbidden = entry.humanRule.forbiddenPhrases.some((phrase) =>
        containsPhrase(comp.title, phrase),
      );
      const variantCorrect = required && !forbidden;
      const conditionCorrect = suggestedConditionCorrect(entry, comp);
      return {
        queryId: query.queryId,
        provider: query.provider,
        compId: comp.id,
        title: comp.title,
        condition: comp.condition,
        displayedPrice: comp.price,
        priceDisclosure: comp.priceDisclosure,
        suggested: {
          compId: comp.id,
          relevant: variantCorrect,
          variantCorrect,
          conditionCorrect,
        },
      };
    });
  });
}

export interface ParsedHumanLabelReview {
  reviewMethod: "human" | "codex-agent-assisted";
  labels: BenchmarkCompLabel[];
}

export function parseHumanLabelFile(value: unknown): ParsedHumanLabelReview {
  const object = value as {
    reviewedByHuman?: unknown;
    reviewedByAgent?: unknown;
    reviewMethod?: unknown;
    labels?: unknown;
  };
  const reviewMethod = object.reviewedByHuman === true
    ? "human"
    : object.reviewedByAgent === true && object.reviewMethod === "codex-agent-assisted"
    ? "codex-agent-assisted"
    : null;
  if (!reviewMethod || !Array.isArray(object.labels)) {
    throw new Error(
      "Attributed labels require either human review or codex-agent-assisted review plus a labels array.",
    );
  }
  const ids = new Set<string>();
  const labels = object.labels.map((raw, index) => {
    const label = raw as Partial<BenchmarkCompLabel>;
    if (
      typeof label.compId !== "string" ||
      typeof label.relevant !== "boolean" ||
      typeof label.variantCorrect !== "boolean" ||
      typeof label.conditionCorrect !== "boolean"
    ) {
      throw new Error(`Invalid attributed label at index ${index}`);
    }
    if (ids.has(label.compId)) {
      throw new Error(`Duplicate attributed label at index ${index}`);
    }
    ids.add(label.compId);
    return {
      compId: label.compId,
      relevant: label.relevant,
      variantCorrect: label.variantCorrect,
      conditionCorrect: label.conditionCorrect,
      ...(typeof label.note === "string" ? { note: label.note } : {}),
    };
  });
  return { reviewMethod, labels };
}

export function parseProductResearchFile(
  value: unknown,
  requiredQueryIds: readonly string[],
): ProductResearchStatus {
  const object = value as {
    capturedAt?: unknown;
    reviewMethod?: unknown;
    window?: unknown;
    tab?: unknown;
    queries?: Array<{
      id?: unknown;
      condition?: unknown;
      averageSoldPriceUsd?: unknown;
      soldPriceMinUsd?: unknown;
      soldPriceMaxUsd?: unknown;
      sellThroughPct?: unknown;
      totalSellers?: unknown;
    }>;
  };
  if (
    object.reviewMethod !==
      "authenticated in-app browser, operator-authorized Codex assistance" ||
    typeof object.capturedAt !== "string" ||
    object.window !== "Last 90 days" ||
    object.tab !== "Sold" ||
    !Array.isArray(object.queries)
  ) {
    throw new Error(
      "Product Research reference requires the operator-authorized Codex capture contract.",
    );
  }
  const ids = new Set<string>();
  const parsedRows: NonNullable<ProductResearchStatus["rows"]> = [];
  for (const [index, row] of object.queries.entries()) {
    if (
      typeof row.id !== "string" ||
      typeof row.condition !== "string" ||
      row.condition.trim().length === 0 ||
      typeof row.averageSoldPriceUsd !== "number" ||
      !Number.isFinite(row.averageSoldPriceUsd) ||
      row.averageSoldPriceUsd <= 0 ||
      typeof row.soldPriceMinUsd !== "number" ||
      !Number.isFinite(row.soldPriceMinUsd) ||
      row.soldPriceMinUsd <= 0 ||
      typeof row.soldPriceMaxUsd !== "number" ||
      !Number.isFinite(row.soldPriceMaxUsd) ||
      row.soldPriceMaxUsd < row.soldPriceMinUsd ||
      row.averageSoldPriceUsd < row.soldPriceMinUsd ||
      row.averageSoldPriceUsd > row.soldPriceMaxUsd ||
      typeof row.sellThroughPct !== "number" ||
      !Number.isFinite(row.sellThroughPct) ||
      row.sellThroughPct < 0 ||
      row.sellThroughPct > 100 ||
      typeof row.totalSellers !== "number" ||
      !Number.isInteger(row.totalSellers) ||
      row.totalSellers < 0
    ) {
      throw new Error(`Invalid Product Research aggregate row at index ${index}`);
    }
    if (ids.has(row.id)) {
      throw new Error(`Duplicate Product Research aggregate row at index ${index}`);
    }
    ids.add(row.id);
    parsedRows.push({
      queryId: row.id,
      condition: row.condition,
      average: row.averageSoldPriceUsd,
      range: { min: row.soldPriceMinUsd, max: row.soldPriceMaxUsd },
      sellThroughPct: row.sellThroughPct,
      totalSellers: row.totalSellers,
      capturedAt: object.capturedAt,
    });
  }
  const missing = requiredQueryIds.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    throw new Error(`Product Research aggregate is missing: ${missing.join(", ")}`);
  }
  return {
    status: "complete",
    queryIds: [...requiredQueryIds],
    reviewMethod: "codex-assisted-operator",
    rows: parsedRows.filter((row) => requiredQueryIds.includes(row.queryId)),
  };
}
