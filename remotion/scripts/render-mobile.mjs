// Batch mp4 renderer — bundle the Remotion project ONCE, then render any set of
// (compositionId, outputPath, theme) jobs. Far faster than repeated
// `npx remotion render` (which re-bundles every call). Matches the per-file
// render recipe: h264, crf 26, muted.
//
// Usage:
//   node remotion/scripts/render-mobile.mjs                 # default: re-render changed clips
//   node remotion/scripts/render-mobile.mjs "step-price-mobile::public/demo/steps/price-mobile.mp4::light"
//
// Each arg is "compId::outPath::theme" (theme optional → light). "::" separates
// because output paths contain "/".
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import path from "node:path";

const DEFAULT = [
  ["step-write-mobile", "public/demo/steps/write-mobile.mp4", "light"],
  ["step-write-mobile", "public/demo/steps/write-mobile-dark.mp4", "dark"],
  ["buyer-qa-mobile", "public/demo/buyer-qa-mobile.mp4", "light"],
  ["buyer-qa-mobile", "public/demo/buyer-qa-mobile-dark.mp4", "dark"],
];

const args = process.argv.slice(2);
const jobs = args.length
  ? args.map((s) => {
      const [id, out, t] = s.split("::");
      return [id, out, t || "light"];
    })
  : DEFAULT;

const entryPoint = path.resolve("remotion/index.ts");
const publicDir = path.resolve("public");

console.log("Bundling", entryPoint, "…");
const serveUrl = await bundle({ entryPoint, publicDir });
console.log("Bundled.");

for (const [id, out, theme] of jobs) {
  const inputProps = theme === "dark" ? { theme: "dark" } : {};
  const composition = await selectComposition({ serveUrl, id, inputProps });
  process.stdout.write(`Rendering ${id} (${theme}) → ${out} … `);
  await renderMedia({
    serveUrl,
    composition,
    codec: "h264",
    crf: 26,
    muted: true,
    outputLocation: path.resolve(out),
    inputProps,
    publicDir,
    overwrite: true,
  });
  console.log("✓");
}
console.log("Done.");
