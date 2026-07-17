/**
 * Zero-network balanced-condition contract evaluation for Issue #200.
 * The fixture is synthetic and output is aggregate-only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateApifyBalancedConditions,
  formatApifyBalancedConditionReport,
} from "../src/lib/pricing/benchmark/apify-readiness";

function outputDirectory(args: readonly string[]): string {
  const index = args.indexOf("--output-dir");
  if (index === -1) return "docs/benchmarks/sold-comps/apify-readiness";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--output-dir requires a value");
  if (args.length !== index + 2) throw new Error("Unknown readiness evaluation argument");
  return value;
}

const summary = evaluateApifyBalancedConditions();
const outputDir = resolve(outputDirectory(process.argv.slice(2)));
mkdirSync(outputDir, { recursive: true });
writeFileSync(
  resolve(outputDir, "contract-results.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  resolve(outputDir, "CONTRACT.md"),
  formatApifyBalancedConditionReport(summary),
  "utf8",
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
