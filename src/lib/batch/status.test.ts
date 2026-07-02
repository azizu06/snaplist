import { describe, expect, it } from "vitest";
import {
  isTerminalTriageStatus,
  triageLabel,
  triageStatusFromListing,
  type TriageStatusKey,
} from "./status";

/**
 * Triage status derivation (issue #100): persisted listing lifecycle →
 * batch-triage vocabulary. This is the pending → priced → needs-review /
 * autopilot-eligible spine the acceptance criteria name.
 */

describe("triageStatusFromListing", () => {
  it("no listing yet reads as processing", () => {
    expect(triageStatusFromListing(null)).toBe("processing");
    expect(triageStatusFromListing(undefined)).toBe("processing");
    expect(triageStatusFromListing("new")).toBe("processing");
  });

  it("draft (below the autopilot gate) reads as needs-review", () => {
    expect(triageStatusFromListing("draft")).toBe("needs-review");
  });

  it("queued (above the autopilot gate) reads as autopilot-eligible", () => {
    expect(triageStatusFromListing("queued")).toBe("autopilot-eligible");
  });

  it("published reads as live", () => {
    expect(triageStatusFromListing("published")).toBe("live");
  });

  it("failed lifecycle keys read as failed", () => {
    expect(triageStatusFromListing("failed")).toBe("failed");
    expect(triageStatusFromListing("draft_failed")).toBe("failed");
  });

  it("unknown / late-lifecycle keys degrade to needs-review (review page is authoritative)", () => {
    expect(triageStatusFromListing("archived")).toBe("needs-review");
    expect(triageStatusFromListing("something_future")).toBe("needs-review");
  });
});

describe("triageLabel", () => {
  it("covers every key with a label + tone (no raw keys ever render)", () => {
    const keys: TriageStatusKey[] = [
      "waiting",
      "processing",
      "needs-review",
      "autopilot-eligible",
      "live",
      "failed",
      "blocked",
    ];
    for (const key of keys) {
      const label = triageLabel(key);
      expect(label.label.length).toBeGreaterThan(0);
      expect(label.tone).toBeTruthy();
    }
  });

  it("processing pulses (transient working state), matching the dashboard idiom", () => {
    expect(triageLabel("processing").pulse).toBe(true);
    expect(triageLabel("needs-review").pulse).toBeUndefined();
  });
});

describe("isTerminalTriageStatus", () => {
  it("waiting/processing are non-terminal; everything else is terminal", () => {
    expect(isTerminalTriageStatus("waiting")).toBe(false);
    expect(isTerminalTriageStatus("processing")).toBe(false);
    expect(isTerminalTriageStatus("needs-review")).toBe(true);
    expect(isTerminalTriageStatus("autopilot-eligible")).toBe(true);
    expect(isTerminalTriageStatus("failed")).toBe(true);
    expect(isTerminalTriageStatus("blocked")).toBe(true);
    expect(isTerminalTriageStatus("live")).toBe(true);
  });
});
