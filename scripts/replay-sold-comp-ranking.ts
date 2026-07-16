/**
 * Offline-only replay for Issue #198.
 *
 * Reads a private normalized capture and attributed labels, then writes only
 * aggregate results. This script has no provider client imports and performs no
 * network calls.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  formatSoldCompRankingReplay,
  replaySoldCompRanking,
} from "../src/lib/pricing/benchmark/ranking-replay";
import { parseHumanLabelFile } from "../src/lib/pricing/benchmark/review";
import type { BenchmarkCapture } from "../src/lib/pricing/benchmark/types";

interface ReplayArgs {
  capturePath: string;
  labelsPath: string;
  outputDir: string;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): ReplayArgs {
  let capturePath: string | undefined;
  let labelsPath: string | undefined;
  let outputDir = "docs/benchmarks/sold-comps/ranking-replay";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--capture") {
      capturePath = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--labels") {
      labelsPath = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--output-dir") {
      outputDir = requiredValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!capturePath || !labelsPath) {
    throw new Error("Offline replay requires --capture and --labels");
  }
  return { capturePath, labelsPath, outputDir };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

const args = parseArgs(process.argv.slice(2));
const capture = readJson(args.capturePath) as BenchmarkCapture;
if (capture.schemaVersion !== 1 || !Array.isArray(capture.queries)) {
  throw new Error("Unsupported sold-comp capture schema");
}
const labels = parseHumanLabelFile(readJson(args.labelsPath)).labels;
const summary = replaySoldCompRanking(capture, labels);
const outputDir = resolve(args.outputDir);
mkdirSync(outputDir, { recursive: true });
writeFileSync(
  resolve(outputDir, "results.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
writeFileSync(resolve(outputDir, "REPORT.md"), formatSoldCompRankingReplay(summary), "utf8");
process.stdout.write(`${JSON.stringify(summary)}\n`);
