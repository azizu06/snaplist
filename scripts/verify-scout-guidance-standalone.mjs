import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const standaloneRoot = resolve(".next/standalone");
const port = String(31_000 + (process.pid % 1_000));
let output = "";
const server = spawn(process.execPath, ["server.js"], {
  cwd: standaloneRoot,
  env: {
    ...process.env,
    HOSTNAME: "0.0.0.0",
    PORT: port,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
      "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
    CLERK_SECRET_KEY:
      process.env.CLERK_SECRET_KEY ?? "standalone-probe-placeholder",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const deadline = Date.now() + 20_000;
let verified = false;

try {
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Standalone server exited early.\n${output}`);
    }
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      const body = await response.json();
      const scoutGuidance = body?.contracts?.scoutGuidance;
      if (
        response.ok &&
        scoutGuidance?.version === "scout-guidance-v1" &&
        scoutGuidance?.state === "onboarding.outcome" &&
        scoutGuidance?.title ===
          "Photograph an item. Get real comps and a listing you control."
      ) {
        verified = true;
        break;
      }
    } catch {
      // The standalone server may still be binding its port.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  if (!verified) {
    throw new Error(
      `Standalone health route did not resolve Scout guidance V1.\n${output}`,
    );
  }
  process.stdout.write("Standalone Scout guidance runtime verified.\n");
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      once(server, "exit"),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
    ]);
  }
  if (server.exitCode === null) server.kill("SIGKILL");
}
