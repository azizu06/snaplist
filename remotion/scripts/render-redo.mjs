/**
 * One-bundle re-render of the consumed demo-video suite (redesign: neutral+green).
 *
 * The CLI (`npx remotion render …`) re-bundles per clip; this bundles
 * remotion/index.ts ONCE and renders every consumed composition off the same
 * serveUrl — light + dark, web + mobile. Outputs land in `public/` at the exact
 * paths the app references (see remotion/INTEGRATION.md).
 *
 *   node remotion/scripts/render-redo.mjs stills   # fast: verification stills only
 *   node remotion/scripts/render-redo.mjs all      # full: all 28 mp4s (long; run in bg)
 *
 * Colors come from remotion/{hero,suite}/theme.ts; dark is the `theme:"dark"`
 * input prop. Geometry/choreography is unchanged (assert-clicks still passes),
 * so this is a pure recolor re-render.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const ENTRY = path.resolve(__dirname, "..", "index.ts");
const PUBLIC = path.join(REPO, "public");

// [composition id, output rel-path under public/, crf, representative still frame]
const WEB = [
  ["hero-demo", "hero-demo.mp4", 28, 430],
  ["step-snap", "demo/steps/snap.mp4", 26, 400],
  ["step-identify", "demo/steps/identify.mp4", 26, 420],
  ["step-price", "demo/steps/price.mp4", 26, 498],
  ["step-write", "demo/steps/write.mp4", 26, 280],
  ["step-publish", "demo/steps/publish.mp4", 26, 399],
  ["buyer-qa", "demo/buyer-qa.mp4", 26, 540],
  ["inbox-qa", "demo/inbox-qa.mp4", 26, 540],
];
const MOBILE = [
  ["step-snap-mobile", "demo/steps/snap-mobile.mp4", 26, 240],
  ["step-identify-mobile", "demo/steps/identify-mobile.mp4", 26, 240],
  ["step-price-mobile", "demo/steps/price-mobile.mp4", 26, 320],
  ["step-write-mobile", "demo/steps/write-mobile.mp4", 26, 280],
  ["step-publish-mobile", "demo/steps/publish-mobile.mp4", 26, 260],
  ["buyer-qa-mobile", "demo/buyer-qa-mobile.mp4", 26, 360],
];

const dark = (rel) => rel.replace(/\.mp4$/, "-dark.mp4");

async function main() {
  const mode = process.argv[2] || "all";
  console.log(`[render-redo] mode=${mode} — bundling once…`);
  const serveUrl = await bundle({
    entryPoint: ENTRY,
    publicDir: PUBLIC,
    onProgress: (p) => {
      if (p === 100 || p % 25 === 0) process.stdout.write(`  bundle ${p}%\r`);
    },
  });
  console.log(`\n[render-redo] bundle ready: ${serveUrl}`);

  const all = [...WEB, ...MOBILE];

  if (mode === "stills") {
    const outDir = path.join(REPO, ".review-shots", "remotion-redo", "verify");
    mkdirSync(outDir, { recursive: true });
    for (const [id, rel, , frame] of all) {
      for (const theme of ["light", "dark"]) {
        const inputProps = theme === "dark" ? { theme: "dark" } : {};
        const comp = await selectComposition({ serveUrl, id, inputProps });
        const safe = rel.replace(/\//g, "__").replace(/\.mp4$/, "");
        const output = path.join(outDir, `${safe}-${theme}.jpg`);
        await renderStill({ composition: comp, serveUrl, output, frame, inputProps, imageFormat: "jpeg", jpegQuality: 82 });
        console.log(`  still ✓ ${id} (${theme}) f${frame}`);
      }
    }
    console.log(`[render-redo] stills in ${outDir}`);
    return;
  }

  // mode === "all": render every consumed clip, light + dark.
  let i = 0;
  const total = all.length * 2;
  for (const [id, rel, crf] of all) {
    for (const theme of ["light", "dark"]) {
      i++;
      const inputProps = theme === "dark" ? { theme: "dark" } : {};
      const outRel = theme === "dark" ? dark(rel) : rel;
      const output = path.join(PUBLIC, outRel);
      mkdirSync(path.dirname(output), { recursive: true });
      const comp = await selectComposition({ serveUrl, id, inputProps });
      process.stdout.write(`[${i}/${total}] ${id} (${theme}) → ${outRel}\n`);
      await renderMedia({
        composition: comp,
        serveUrl,
        codec: "h264",
        crf,
        muted: true,
        inputProps,
        outputLocation: output,
        onProgress: ({ progress }) => {
          process.stdout.write(`    ${Math.round(progress * 100)}%\r`);
        },
      });
      process.stdout.write(`    done\n`);
    }
  }
  console.log(`[render-redo] all ${total} clips rendered to public/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
