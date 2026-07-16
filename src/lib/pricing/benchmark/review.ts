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

export function parseHumanLabelFile(value: unknown): BenchmarkCompLabel[] {
  const object = value as {
    reviewedByHuman?: unknown;
    labels?: unknown;
  };
  if (object.reviewedByHuman !== true || !Array.isArray(object.labels)) {
    throw new Error("Human labels require reviewedByHuman=true and a labels array.");
  }
  const ids = new Set<string>();
  return object.labels.map((raw, index) => {
    const label = raw as Partial<BenchmarkCompLabel>;
    if (
      typeof label.compId !== "string" ||
      typeof label.relevant !== "boolean" ||
      typeof label.variantCorrect !== "boolean" ||
      typeof label.conditionCorrect !== "boolean"
    ) {
      throw new Error(`Invalid human label at index ${index}`);
    }
    if (ids.has(label.compId)) {
      throw new Error(`Duplicate human label at index ${index}`);
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
}

export function parseProductResearchFile(
  value: unknown,
  requiredQueryIds: readonly string[],
): ProductResearchStatus {
  const object = value as {
    reviewedByHuman?: unknown;
    rows?: Array<{ queryId?: unknown; resultCount?: unknown; median?: unknown; range?: unknown }>;
  };
  if (object.reviewedByHuman !== true || !Array.isArray(object.rows)) {
    throw new Error("Product Research reference requires reviewedByHuman=true and rows.");
  }
  const ids = new Set<string>();
  const parsedRows: NonNullable<ProductResearchStatus["rows"]> = [];
  for (const [index, row] of object.rows.entries()) {
    const range = row.range as { min?: unknown; max?: unknown } | undefined;
    if (
      typeof row.queryId !== "string" ||
      typeof row.resultCount !== "number" ||
      !Number.isInteger(row.resultCount) ||
      row.resultCount < 0 ||
      typeof row.median !== "number" ||
      !Number.isFinite(row.median) ||
      row.median <= 0 ||
      typeof range?.min !== "number" ||
      !Number.isFinite(range.min) ||
      range.min <= 0 ||
      typeof range?.max !== "number" ||
      !Number.isFinite(range.max) ||
      range.max < range.min ||
      row.median < range.min ||
      row.median > range.max
    ) {
      throw new Error(`Invalid Product Research aggregate row at index ${index}`);
    }
    if (ids.has(row.queryId)) {
      throw new Error(`Duplicate Product Research aggregate row at index ${index}`);
    }
    ids.add(row.queryId);
    parsedRows.push({
      queryId: row.queryId,
      resultCount: row.resultCount,
      median: row.median,
      range: { min: range.min, max: range.max },
      ...(typeof (row as { reviewedAt?: unknown }).reviewedAt === "string"
        ? { reviewedAt: (row as { reviewedAt: string }).reviewedAt }
        : {}),
    });
  }
  const missing = requiredQueryIds.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    throw new Error(`Product Research aggregate is missing: ${missing.join(", ")}`);
  }
  return {
    status: "complete",
    queryIds: [...requiredQueryIds],
    rows: parsedRows.filter((row) => requiredQueryIds.includes(row.queryId)),
  };
}
