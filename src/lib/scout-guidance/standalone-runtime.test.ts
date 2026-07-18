import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Scout guidance standalone container proof", () => {
  it("runs the probe only after the final artifacts are copied under the non-root runner user", () => {
    const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
    const runnerStage = dockerfile.indexOf("FROM node:22-alpine AS runner");
    const runnerUser = dockerfile.indexOf("USER nextjs", runnerStage);
    const standaloneCopy = dockerfile.indexOf(
      "COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./",
      runnerStage,
    );
    const staticCopy = dockerfile.indexOf(
      "COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static",
      runnerStage,
    );
    const publicCopy = dockerfile.indexOf(
      "COPY --from=build --chown=nextjs:nodejs /app/public ./public",
      runnerStage,
    );
    const runtimeProbe = dockerfile.search(
      /^RUN .*verify(?:-scout-guidance-standalone|:standalone-scout)/m,
    );

    expect(runnerStage).toBeGreaterThan(-1);
    for (const artifactCopy of [standaloneCopy, staticCopy, publicCopy]) {
      expect(artifactCopy).toBeGreaterThan(runnerStage);
      expect(artifactCopy).toBeLessThan(runtimeProbe);
    }
    expect(runnerUser).toBeGreaterThan(runnerStage);
    expect(runtimeProbe).toBeGreaterThan(runnerUser);
    expect(dockerfile.slice(0, runnerStage)).not.toMatch(
      /^RUN .*verify(?:-scout-guidance-standalone|:standalone-scout)/m,
    );
  });
});
