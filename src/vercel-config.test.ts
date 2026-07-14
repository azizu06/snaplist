import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type VercelConfig = {
  crons?: Array<{ path: string; schedule: string }>;
};

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL("../vercel.json", import.meta.url)), "utf8"),
) as VercelConfig;

describe("Vercel deployment configuration", () => {
  it("keeps five-minute inbox sync off the Hobby-limited Vercel scheduler", () => {
    expect(config.crons).not.toContainEqual(
      expect.objectContaining({ path: "/api/cron/inbox-sync" }),
    );
  });
});
