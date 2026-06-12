import { describe, expect, it } from "vitest";
import { relativeDay } from "./dates";

/** The dashboard's Created column: relative for the recent past (where
 * "when did I list this" is the real question), absolute beyond a week. */
describe("relativeDay", () => {
  const now = new Date("2026-06-12T18:00:00Z").getTime();

  it("labels today and yesterday", () => {
    expect(relativeDay("2026-06-12T09:00:00Z", now)).toBe("Today");
    expect(relativeDay("2026-06-11T23:00:00Z", now)).toBe("Yesterday");
  });

  it("uses day counts up to a week", () => {
    expect(relativeDay("2026-06-09T12:00:00Z", now)).toBe("3d ago");
    expect(relativeDay("2026-06-06T12:00:00Z", now)).toBe("6d ago");
  });

  it("falls back to a short date beyond a week, and for bad input", () => {
    expect(relativeDay("2026-05-20T12:00:00Z", now)).toMatch(/May/);
    expect(relativeDay("", now)).toBe("—");
    expect(relativeDay("not-a-date", now)).toBe("—");
  });
});
