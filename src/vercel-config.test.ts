import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type VercelConfig = {
  crons?: Array<{ path: string; schedule: string }>;
};

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL("../vercel.json", import.meta.url)), "utf8"),
) as VercelConfig;

const scheduledPaths = (config.crons ?? []).map((entry) => entry.path);

describe("Vercel deployment configuration", () => {
  it("schedules no autonomous marketplace sweep", () => {
    expect(scheduledPaths).not.toContain("/api/cron/reprice");
  });

  it("leaves no empty crons array behind when the last job is removed", () => {
    expect(config.crons).not.toEqual([]);
  });
});
