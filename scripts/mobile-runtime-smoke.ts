import { runMobileRuntimeSmoke } from "../src/runtime/node/smoke";

async function main(): Promise<void> {
  const result = await runMobileRuntimeSmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main();
