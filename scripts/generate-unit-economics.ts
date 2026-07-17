import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { calculateUnitEconomics } from "../src/lib/unit-economics/calculate";
import { unitEconomicsModelSchema } from "../src/lib/unit-economics/schema";

const modelPath = fileURLToPath(
  new URL("../docs/unit-economics/snaplist-pro-model.json", import.meta.url),
);
const resultsPath = fileURLToPath(
  new URL("../docs/unit-economics/snaplist-pro-results.json", import.meta.url),
);

const model = unitEconomicsModelSchema.parse(
  JSON.parse(readFileSync(modelPath, "utf8")),
);
const serialized = `${JSON.stringify(calculateUnitEconomics(model), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existing = readFileSync(resultsPath, "utf8");
  if (existing !== serialized) {
    console.error(
      "Unit-economics results are stale. Run pnpm unit-economics:generate.",
    );
    process.exitCode = 1;
  } else {
    console.log("Unit-economics model and generated results are valid and current.");
  }
} else {
  writeFileSync(resultsPath, serialized);
  console.log(`Generated ${resultsPath}`);
}
