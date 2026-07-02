/**
 * Spike #104 — pull the gold-fixture photos to local disk.
 *
 * The photos are other sellers' eBay images, so they are NOT committed to this
 * public repo (see fixtures/.gitignore). This script re-materializes them from
 * the provenance URLs in fixtures.json:
 *
 *   pnpm exec tsx scripts/spike/fetch-images.ts
 *
 * eBay image URLs encode the size in the filename (s-l1600.jpg); we rewrite to
 * s-l1024 so the vision calls stay small without an image-processing dependency.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { SPIKE_DIR } from "./env";
import { goldFixturesSchema } from "./types";

const FIXTURES = path.join(SPIKE_DIR, "fixtures", "fixtures.json");
const IMAGES_DIR = path.join(SPIKE_DIR, "fixtures", "images");

function resized(url: string): string {
  return url.replace(/s-l\d+(\.(jpg|jpeg|png|webp))/i, "s-l1024$1");
}

async function main(): Promise<void> {
  const gold = goldFixturesSchema.parse(JSON.parse(readFileSync(FIXTURES, "utf8")));
  mkdirSync(IMAGES_DIR, { recursive: true });

  let fetched = 0;
  let skipped = 0;
  const failures: string[] = [];
  const jobs = gold.flatMap((f) => [
    { id: f.id, file: `${f.id}.jpg`, url: f.image_url },
    ...(f.extra_image_urls ?? []).map((url, i) => ({
      id: f.id,
      file: `${f.id}-${i + 2}.jpg`,
      url,
    })),
  ]);
  for (const f of jobs) {
    const dest = path.join(IMAGES_DIR, f.file);
    if (existsSync(dest)) {
      skipped += 1;
      continue;
    }
    const url = resized(f.url);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "snaplist-spike-104/0.1 (fixture re-fetch)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 5_000) throw new Error(`suspiciously small (${bytes.length}B)`);
      writeFileSync(dest, bytes);
      fetched += 1;
      console.log(`fetched ${f.file} (${Math.round(bytes.length / 1024)}KB)`);
    } catch (err) {
      failures.push(`${f.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${fetched} fetched, ${skipped} already present, ${failures.length} failed`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main();
