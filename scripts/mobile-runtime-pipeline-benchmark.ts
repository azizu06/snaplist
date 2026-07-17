import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runOfflinePipelineBenchmark } from "../src/runtime/node/pipeline-benchmark";

const FIXTURES = [
  "public/demo/headphones.jpg",
  "public/demo/camera.jpg",
  "public/demo/macbook.jpg",
  "public/demo/book.jpg",
];

async function main(): Promise<void> {
  const fixturePhotos = await Promise.all(
    FIXTURES.map(async (path) => Uint8Array.from(await readFile(resolve(path)))),
  );
  const result = await runOfflinePipelineBenchmark({ fixturePhotos });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main();
