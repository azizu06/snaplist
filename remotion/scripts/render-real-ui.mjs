/**
 * Render the real-UI marketing-tour media after capture-real-ui.mjs.
 * Bundles Remotion once, then writes the exact paths consumed by the app.
 *
 *   pnpm demo:render-real-ui
 *   pnpm demo:render-real-ui -- stills
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const ENTRY = path.join(REPO, "remotion", "index.ts");
const PUBLIC = path.join(REPO, "public");
const RENDER_ONLY = new Set(
  (process.env.DEMO_RENDER_ONLY ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const DESKTOP = [
  ["step-snap", "demo/steps/snap.mp4"],
  ["step-identify", "demo/steps/identify.mp4"],
  ["step-price", "demo/steps/price.mp4"],
  ["step-write", "demo/steps/write.mp4"],
  ["step-publish", "demo/steps/publish.mp4"],
];

const MOBILE = [
  ["step-snap-mobile", "demo/steps/snap-mobile.mp4"],
  ["step-identify-mobile", "demo/steps/identify-mobile.mp4"],
  ["step-price-mobile", "demo/steps/price-mobile.mp4"],
  ["step-write-mobile", "demo/steps/write-mobile.mp4"],
  ["step-publish-mobile", "demo/steps/publish-mobile.mp4"],
];

const darkPath = (file) => file.replace(/\.mp4$/, "-dark.mp4");

async function main() {
  const mode = process.argv.includes("stills") ? "stills" : "media";
  process.stdout.write(`[render-real-ui] ${mode}: bundling once…\n`);
  const serveUrl = await bundle({ entryPoint: ENTRY, publicDir: PUBLIC });
  const jobs = [...DESKTOP, ...MOBILE]
    .filter(([id]) => RENDER_ONLY.size === 0 || RENDER_ONLY.has(id))
    .flatMap(([id, output]) => [
      { id, output, theme: "light" },
      { id, output: darkPath(output), theme: "dark" },
    ]);

  if (mode === "stills") {
    const stillRoot = path.join(REPO, ".review-shots", "real-ui-media");
    mkdirSync(stillRoot, { recursive: true });
    for (const { id, output, theme } of jobs) {
      const inputProps = { theme };
      const composition = await selectComposition({ serveUrl, id, inputProps });
      const still = path.join(stillRoot, output.replaceAll("/", "__").replace(/\.mp4$/, ".png"));
      await renderStill({
        composition,
        serveUrl,
        output: still,
        frame: Math.floor(composition.durationInFrames * 0.55),
        inputProps,
        imageFormat: "png",
      });
      process.stdout.write(`  still ✓ ${id} (${theme})\n`);
    }
    return;
  }

  let index = 0;
  for (const { id, output, theme } of jobs) {
    index += 1;
    const inputProps = { theme };
    const outputLocation = path.join(PUBLIC, output);
    mkdirSync(path.dirname(outputLocation), { recursive: true });
    const composition = await selectComposition({ serveUrl, id, inputProps });
    process.stdout.write(`  [${index}/${jobs.length}] ${id} (${theme}) → ${output}\n`);
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      crf: 25,
      muted: true,
      inputProps,
      outputLocation,
      overwrite: true,
    });
  }
  process.stdout.write(`[render-real-ui] ${jobs.length} clips rendered\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
