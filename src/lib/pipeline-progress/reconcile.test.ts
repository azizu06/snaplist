import { describe, expect, it } from "vitest";
import { isPipelineProgressUpdateStale } from "./reconcile";
import type { PipelineProgressRun } from "./status";

const BASE: PipelineProgressRun = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "seller-1",
  item_id: "00000000-0000-4000-8000-000000000002",
  listing_id: null,
  status: "queued",
  stage: "queued",
  attempt_count: 0,
  max_attempts: 3,
  safe_failure_message: null,
  retention_cleaned_at: null,
  updated_at: "2026-07-15T12:00:00.000Z",
};

describe("isPipelineProgressUpdateStale", () => {
  it("treats an earlier timestamp as stale", () => {
    const candidate = { ...BASE, updated_at: "2026-07-15T11:59:59.000Z" };
    const accepted = { ...BASE, updated_at: "2026-07-15T12:00:00.000Z" };
    expect(isPipelineProgressUpdateStale(candidate, accepted)).toBe(true);
  });

  it("treats a later timestamp as not stale", () => {
    const candidate = { ...BASE, updated_at: "2026-07-15T12:00:01.000Z" };
    const accepted = { ...BASE, updated_at: "2026-07-15T12:00:00.000Z" };
    expect(isPipelineProgressUpdateStale(candidate, accepted)).toBe(false);
  });

  it("breaks a millisecond tie using the microsecond fraction", () => {
    const candidate = { ...BASE, updated_at: "2026-07-15T12:00:00.123001Z" };
    const accepted = { ...BASE, updated_at: "2026-07-15T12:00:00.123456Z" };
    expect(isPipelineProgressUpdateStale(candidate, accepted)).toBe(true);
  });

  it("does not mark the larger microsecond fraction stale", () => {
    const candidate = { ...BASE, updated_at: "2026-07-15T12:00:00.123456Z" };
    const accepted = { ...BASE, updated_at: "2026-07-15T12:00:00.123001Z" };
    expect(isPipelineProgressUpdateStale(candidate, accepted)).toBe(false);
  });

  it("treats identical timestamps as not stale", () => {
    const candidate = { ...BASE, updated_at: "2026-07-15T12:00:00.123456Z" };
    const accepted = { ...BASE, updated_at: "2026-07-15T12:00:00.123456Z" };
    expect(isPipelineProgressUpdateStale(candidate, accepted)).toBe(false);
  });

  it("falls back to string comparison when a timestamp cannot be parsed", () => {
    const candidate = { ...BASE, updated_at: "not-a-timestamp-a" };
    const accepted = { ...BASE, updated_at: "not-a-timestamp-b" };
    expect(isPipelineProgressUpdateStale(candidate, accepted)).toBe(true);
  });
});
