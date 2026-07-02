/**
 * Spike #104 — score predictions.json against fixtures.json and write RESULTS.md.
 * Pure post-processing: re-runnable without spending any model calls.
 *
 *   pnpm exec tsx scripts/spike/report.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SPIKE_DIR } from "./env";
import { scoreSpike, type CohortSummary } from "./score";
import { goldFixturesSchema, predictionRecordsSchema } from "./types";

const FIXTURES = path.join(SPIKE_DIR, "fixtures", "fixtures.json");
const PREDICTIONS = path.join(SPIKE_DIR, "predictions.json");
const RESULTS = path.join(SPIKE_DIR, "RESULTS.md");

const fmt = (v: number | null, digits = 2): string => (v === null ? "—" : v.toFixed(digits));
const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);

function cohortRow(label: string, c: CohortSummary): string {
  const d = c.discrimination;
  return `| ${label} | ${c.n} | ${fmt(c.medianAbsError)} | ${pct(c.pctWithin1)} | ${pct(
    c.pctWithin1_5,
  )} | ${d.correct}/${d.pairs} (${pct(d.rate)}) |`;
}

function main(): void {
  const gold = goldFixturesSchema.parse(JSON.parse(readFileSync(FIXTURES, "utf8")));
  const predictions = predictionRecordsSchema.parse(
    JSON.parse(readFileSync(PREDICTIONS, "utf8")),
  );
  const s = scoreSpike(gold, predictions);
  const models = [...new Set(predictions.map((p) => p.model))].join("`, `") || "unknown";

  const lines: string[] = [];
  lines.push("# Spike #104 — garment measurements from flat-lay photos: results");
  lines.push("");
  lines.push(`## Verdict: **${s.verdict}**`);
  lines.push("");
  lines.push(s.verdictReason);
  lines.push("");
  lines.push(
    `Model(s): \`${models}\` (Google/Gemini, dev provider — pinned; no OpenAI spend). ` +
      `${gold.length} fixtures, ${s.rows.length} matched measurements, ` +
      `${s.missedGold} seller-stated measurements the model did not return` +
      (s.failedFixtures.length > 0
        ? `, ${s.failedFixtures.length} fixtures failed (${s.failedFixtures.join(", ")})`
        : "") +
      ".",
  );
  lines.push("");
  lines.push("### GO bar (agreed 2026-07-02: the \"size-class bar\")");
  lines.push("");
  lines.push(
    "GO requires, on photos **with** a scale cue: median absolute error ≤ 1.5in **and** " +
      "≥ 90% correct ordering of garment pairs whose true measurements differ by ≥ 3in " +
      "(the \"is this the 21in or the 24in pit-to-pit\" question buyers actually ask). " +
      "The stricter ±1in band from issue #104 is reported below but does not decide the " +
      "verdict alone — seller-stated ground truth is itself only ±~0.5in.",
  );
  lines.push("");
  lines.push("## By scale-cue cohort");
  lines.push("");
  lines.push("| Cohort | n | Median abs err (in) | ≤1.0in | ≤1.5in | ≥3in-gap ordering |");
  lines.push("|---|---|---|---|---|---|");
  lines.push(cohortRow("With scale cue", s.withCue));
  lines.push(cohortRow("Without scale cue", s.withoutCue));
  lines.push(cohortRow("Overall", s.overall));
  lines.push("");
  lines.push("## By measurement");
  lines.push("");
  lines.push("| Measurement | n | Median abs err (in) | ≤1.0in | ≤1.5in |");
  lines.push("|---|---|---|---|---|");
  for (const [name, m] of Object.entries(s.byMeasurement)) {
    lines.push(
      `| ${name} | ${m.n} | ${fmt(m.medianAbsError)} | ${pct(m.pctWithin1)} | ${pct(
        m.pctWithin1_5,
      )} |`,
    );
  }
  lines.push("");
  lines.push("## Every prediction vs ground truth");
  lines.push("");
  lines.push(
    "| Fixture | Garment | Cue | Measurement | Seller (in) | Model (in) | Abs err | Method | Model ± |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of [...s.rows].sort(
    (a, b) => Number(b.scaleCue) - Number(a.scaleCue) || a.fixtureId.localeCompare(b.fixtureId),
  )) {
    lines.push(
      `| ${r.fixtureId} | ${r.garmentType} | ${r.scaleCue ? "yes" : "no"} | ${r.name} | ` +
        `${r.gt} | ${r.pred} | ${r.absError.toFixed(2)} | ${r.method} | ±${r.toleranceIn} |`,
    );
  }
  lines.push("");
  lines.push("## Method & caveats");
  lines.push("");
  lines.push(
    "- **Gold data:** real eBay listings where the seller stated flat-lay measurements; " +
      "each photo visually verified as a flat-lay. Provenance URLs in " +
      "`fixtures/fixtures.json`; the photos themselves are **not** committed (public " +
      "repo, sellers' images) — `fetch-images.ts` re-materializes them locally.",
  );
  lines.push(
    "- **Ground-truth noise:** sellers measure by hand; ±0.5in of the reported error " +
      "is plausibly the seller's, not the model's. That is why the verdict uses the " +
      "size-class bar rather than the raw ±1in band.",
  );
  lines.push(
    "- **One call per fixture.** Most fixtures are a single photo; the two scale-cue " +
      "fixtures include 2–3 photos (tape close-up + full flat-lay), matching the " +
      "product's 1–4-photo vision call and how measurement-photographing sellers " +
      "actually shoot.",
  );
  lines.push(
    "- **Model split (quota):** the 14 no-cue fixtures ran on `gemini-2.5-flash`; the " +
      "2 cue fixtures ran on `gemini-2.5-flash-lite` after the free-tier daily cap was " +
      "hit. The weaker model on the decisive arm biases AGAINST the reference-scaling " +
      "hypothesis, so its strong showing is conservative — but a same-model rerun " +
      "after quota reset is the cheap follow-up before trusting it.",
  );
  lines.push(
    "- **Ordering & cross-model pairs:** the verdict's size-class ordering uses only the " +
      "**with-cue** cohort, whose pairs are same-model (both cue fixtures ran on one Gemini). " +
      "The Overall and Without-cue ordering figures above pool pairs across the two models " +
      "(`gemini-2.5-flash` vs `gemini-2.5-flash-lite`), so they include cross-model " +
      "comparisons and are context, not the bar.",
  );
  lines.push(
    "- **`method` is the model's self-report**; the cohort split uses the fixture's " +
      "human-verified `scale_cue` flag, not the model's claim.",
  );
  lines.push(
    "- Fixtures rot as listings end; the verdict table above is the durable artifact.",
  );
  lines.push("");

  writeFileSync(RESULTS, `${lines.join("\n")}\n`);
  console.log(`Wrote ${RESULTS}`);
  console.log(`\nVerdict: ${s.verdict} — ${s.verdictReason}`);
}

main();
