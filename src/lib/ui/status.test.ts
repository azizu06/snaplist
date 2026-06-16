import { describe, expect, it } from "vitest";
import {
  confidenceBand,
  confidenceLabel,
  lifecycleLabel,
  lifecycleShortLabel,
  tierLabel,
} from "./status";

/**
 * X-4 (issue #40): the status/confidence/tier vocabulary is ONE source of truth
 * for every surface. These tests pin the exact end-user strings the audit
 * specifies — jargon like "web_tight" or a bare lowercase "draft" must never
 * reach a rendered label again.
 */

describe("lifecycleLabel", () => {
  it("translates every persisted listing status to a labeled tone", () => {
    // Restrained palette: in-flight states are `neutral` (color is reserved for
    // Live + Needs attention); the label still says what each one is.
    expect(lifecycleLabel("draft")).toEqual({
      label: "Needs review",
      tone: "neutral",
    });
    expect(lifecycleLabel("queued")).toEqual({
      label: "Scheduled",
      tone: "neutral",
    });
    expect(lifecycleLabel("published")).toEqual({
      label: "Live",
      tone: "success-solid",
    });
    expect(lifecycleLabel("failed")).toEqual({
      label: "Needs attention",
      tone: "danger",
    });
    expect(lifecycleLabel("draft_failed")).toEqual({
      label: "Needs attention",
      tone: "danger",
    });
  });

  it("renders an unknown/legacy status honestly instead of guessing", () => {
    expect(lifecycleLabel("new")).toEqual({ label: "Processing", tone: "neutral" });
    expect(lifecycleLabel("something_else")).toEqual({
      label: "something_else",
      tone: "neutral",
    });
    expect(lifecycleLabel(null)).toBeNull();
    expect(lifecycleLabel(undefined)).toBeNull();
  });
});

describe("lifecycleShortLabel", () => {
  it("compacts the chip for narrow surfaces, keeping the SAME tone", () => {
    expect(lifecycleShortLabel("draft")).toEqual({ label: "Needs review", tone: "neutral" });
    expect(lifecycleShortLabel("queued")).toEqual({ label: "Scheduled", tone: "neutral" });
    expect(lifecycleShortLabel("published")).toEqual({ label: "Live", tone: "success-solid" });
    expect(lifecycleShortLabel("failed")).toEqual({ label: "Attention", tone: "danger" });
    expect(lifecycleShortLabel("draft_failed")).toEqual({ label: "Attention", tone: "danger" });
    expect(lifecycleShortLabel("new")).toEqual({ label: "Processing", tone: "neutral" });
  });

  it("falls back to the long label's honest rendering for unknown/null", () => {
    expect(lifecycleShortLabel("something_else")).toEqual({
      label: "something_else",
      tone: "neutral",
    });
    expect(lifecycleShortLabel(null)).toBeNull();
  });
});

describe("confidenceBand", () => {
  it("buckets on the autopilot threshold boundaries (high ≥ .75, medium ≥ .5)", () => {
    expect(confidenceBand(0.75)).toBe("high");
    expect(confidenceBand(0.9)).toBe("high");
    expect(confidenceBand(0.5)).toBe("medium");
    expect(confidenceBand(0.7499)).toBe("medium");
    expect(confidenceBand(0.49)).toBe("low");
    expect(confidenceBand(0)).toBe("low");
  });

  it("returns null for missing confidence", () => {
    expect(confidenceBand(null)).toBeNull();
    expect(confidenceBand(undefined)).toBeNull();
  });
});

describe("confidenceLabel", () => {
  it("shows band + percentage + consequence, not a bare number (R-3)", () => {
    expect(confidenceLabel(0.82)).toEqual({
      label: "High confidence (82%)",
      detail: "Strong enough for autopilot",
      tone: "success",
    });
    expect(confidenceLabel(0.6)).toEqual({
      label: "Medium confidence (60%)",
      detail: "Worth a quick check",
      tone: "warning",
    });
    expect(confidenceLabel(0.3)).toEqual({
      label: "Low confidence (30%)",
      detail: "Please double-check before publishing",
      tone: "neutral",
    });
    expect(confidenceLabel(null)).toBeNull();
  });
});

describe("tierLabel", () => {
  it("translates every pricing tier to the audited human label (R-1)", () => {
    expect(tierLabel("isbn-lookup")).toBe("Exact match: ISBN lookup");
    // The eBay-sold tier must surface its real evidence, not the "AI estimate"
    // fallback (#56 review): a sold-grounded price is the strongest comp signal.
    expect(tierLabel("ebay-sold")).toBe("Verified eBay sold comps");
    expect(tierLabel("web_tight")).toBe("Strong market comps");
    expect(tierLabel("web_wide")).toBe("Mixed market comps");
    expect(tierLabel("depreciation")).toBe("Estimated from retail price");
    expect(tierLabel("llm_only")).toBe("Rough AI estimate");
  });

  it("never renders a raw unknown tier key — falls back to a generic label", () => {
    expect(tierLabel("future_tier_v2")).toBe("AI estimate");
    expect(tierLabel(null)).toBeNull();
    expect(tierLabel(undefined)).toBeNull();
  });
});
