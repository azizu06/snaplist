import { describe, expect, it } from "vitest";
import {
  bulkStatusDecision,
  confidenceBand,
  confidenceLabel,
  isBulkEditableStatus,
  isLiveListingRow,
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
    // Active + Needs attention); the label still says what each one is.
    // Labels track Shopify's Products vocabulary: Draft / Active.
    expect(lifecycleLabel("draft")).toEqual({
      label: "Draft",
      tone: "warning",
    });
    expect(lifecycleLabel("queued")).toEqual({
      label: "Scheduled",
      tone: "info",
      icon: "clock",
    });
    expect(lifecycleLabel("published")).toEqual({
      label: "Active",
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
    // Processing pulses (transient "working" state) so it doesn't blur against
    // the static-blue Scheduled under the locked one-blue palette.
    expect(lifecycleLabel("new")).toEqual({ label: "Processing", tone: "info", pulse: true });
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
    expect(lifecycleShortLabel("draft")).toEqual({ label: "Draft", tone: "warning" });
    expect(lifecycleShortLabel("queued")).toEqual({ label: "Scheduled", tone: "info", icon: "clock" });
    expect(lifecycleShortLabel("published")).toEqual({ label: "Active", tone: "success-solid" });
    expect(lifecycleShortLabel("failed")).toEqual({ label: "Attention", tone: "danger" });
    expect(lifecycleShortLabel("draft_failed")).toEqual({ label: "Attention", tone: "danger" });
    expect(lifecycleShortLabel("new")).toEqual({ label: "Processing", tone: "info", pulse: true });
  });

  it("falls back to the long label's honest rendering for unknown/null", () => {
    expect(lifecycleShortLabel("something_else")).toEqual({
      label: "something_else",
      tone: "neutral",
    });
    expect(lifecycleShortLabel(null)).toBeNull();
  });
});

describe("isBulkEditableStatus", () => {
  it("allows only the seller-organizational statuses (draft, archived)", () => {
    expect(isBulkEditableStatus("draft")).toBe(true);
    expect(isBulkEditableStatus("archived")).toBe(true);
  });

  it("rejects the publish-flow statuses so bulk-edit can't bypass the eBay adapter (Codex P1)", () => {
    // `published` (Live) is written only by the eBay publish path alongside the
    // ebay_* fields; `queued` (Scheduled) only by the autopilot gate. Neither may
    // be set by a bulk metadata edit — incl. a crafted request past the UI.
    expect(isBulkEditableStatus("published")).toBe(false);
    expect(isBulkEditableStatus("queued")).toBe(false);
    expect(isBulkEditableStatus("new")).toBe(false);
    expect(isBulkEditableStatus("failed")).toBe(false);
    expect(isBulkEditableStatus("")).toBe(false);
  });
});

describe("isLiveListingRow", () => {
  it("is live only with BOTH an eBay listing id AND ebay_status published", () => {
    expect(
      isLiveListingRow({ ebay_listing_id: "v1|1234567890|0", ebay_status: "published" }),
    ).toBe(true);
  });

  it("is NOT live when either authoritative eBay field is missing/not published", () => {
    // A local "published" status with no eBay id (never posted) is NOT live — the
    // whole point of the guard: status alone can't make a listing live.
    expect(isLiveListingRow({ ebay_listing_id: null, ebay_status: "published" })).toBe(false);
    expect(isLiveListingRow({ ebay_listing_id: "", ebay_status: "published" })).toBe(false);
    // Has an eBay id but the eBay side ended/sold — no longer live.
    expect(isLiveListingRow({ ebay_listing_id: "v1|1|0", ebay_status: "ended" })).toBe(false);
    expect(isLiveListingRow({ ebay_listing_id: "v1|1|0", ebay_status: null })).toBe(false);
    expect(isLiveListingRow({})).toBe(false);
  });
});

describe("bulkStatusDecision", () => {
  it("skips when no status change is requested or the row has no listing yet", () => {
    expect(bulkStatusDecision({ status: undefined, hasListing: true, isLive: false })).toBe("skip");
    expect(bulkStatusDecision({ status: "draft", hasListing: false, isLive: false })).toBe("skip");
  });

  it("rejects a status outside the seller-organizational vocabulary (Codex P1)", () => {
    // published/queued are owned by the publish path / autopilot gate; a crafted
    // request past the disabled UI must never write them via bulk-edit.
    expect(bulkStatusDecision({ status: "published", hasListing: true, isLive: false })).toBe("reject-vocab");
    expect(bulkStatusDecision({ status: "queued", hasListing: true, isLive: false })).toBe("reject-vocab");
    expect(bulkStatusDecision({ status: "new", hasListing: true, isLive: false })).toBe("reject-vocab");
  });

  it("refuses to move a LIVE eBay listing, even to a bulk-editable status (Codex)", () => {
    expect(bulkStatusDecision({ status: "draft", hasListing: true, isLive: true })).toBe("skip-live");
    expect(bulkStatusDecision({ status: "archived", hasListing: true, isLive: true })).toBe("skip-live");
  });

  it("writes a bulk-editable status on a non-live listing — the only persisting case", () => {
    expect(bulkStatusDecision({ status: "draft", hasListing: true, isLive: false })).toBe("write");
    expect(bulkStatusDecision({ status: "archived", hasListing: true, isLive: false })).toBe("write");
  });

  it("checks vocabulary BEFORE liveness, so the reported reason is accurate", () => {
    // A crafted live + out-of-vocab request stays a vocab reject (not skip-live),
    // so the audit log names the real violation.
    expect(bulkStatusDecision({ status: "published", hasListing: true, isLive: true })).toBe("reject-vocab");
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
