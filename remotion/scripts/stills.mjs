// Dev preview harness — bundle the Remotion project ONCE, then render still
// PNGs for any (compositionId, frame, theme) so the portrait-mobile layout can
// be eyeballed and iterated without rendering full mp4s.
//
// Usage:
//   node remotion/scripts/stills.mjs                       # default mobile sweep, light
//   node remotion/scripts/stills.mjs step-price-mobile:300:dark step-write-mobile:360:light
//   OUT_DIR=/tmp/foo node remotion/scripts/stills.mjs ...
//
// Each arg is "compId:frame:theme" (theme optional, defaults light).
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";
import path from "node:path";
import fs from "node:fs";

const OUT = process.env.OUT_DIR || "/tmp/snaplist-stills";
fs.mkdirSync(OUT, { recursive: true });

const DEFAULT = [
  ["step-snap-mobile", 300, "light"],
  ["step-identify-mobile", 300, "light"],
  ["step-price-mobile", 300, "light"],
  ["step-write-mobile", 360, "light"],
  ["step-publish-mobile", 300, "light"],
  ["buyer-qa-mobile", 340, "light"],
];

const args = process.argv.slice(2);
const jobs = args.length
  ? args.map((s) => {
      const [id, f, t] = s.split(":");
      return [id, Number(f), t || "light"];
    })
  : DEFAULT;

const entryPoint = path.resolve("remotion/index.ts");
const publicDir = path.resolve("public");

console.log("Bundling", entryPoint, "…");
const serveUrl = await bundle({ entryPoint, publicDir });
console.log("Bundled.");

for (const [id, frame, theme] of jobs) {
  const inputProps = theme === "dark" ? { theme: "dark" } : {};
  const composition = await selectComposition({ serveUrl, id, inputProps });
  const output = path.join(OUT, `${id}-${theme}-f${frame}.png`);
  await renderStill({
    serveUrl,
    composition,
    output,
    frame,
    inputProps,
    publicDir,
    overwrite: true,
  });
  console.log("✓", output, `(${composition.width}x${composition.height})`);
}
console.log("Done →", OUT);
